import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type PgBoss from "pg-boss";
import { AppError, type TypedEnvelope } from "@aca/contracts";
import { publishJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { manifestObjectKey } from "@aca/storage";
import { APP_CONFIG } from "../../config/config.module";
import type { AiEnv } from "../../config/env";
import { APP_LOGGER, PG_BOSS } from "../../shared/infra.module";
import { chunkFile } from "./chunking/chunker";
import type { ChunkSpec } from "./chunking/chunk-types";
import { CodeChunksRepository, type InsertCodeChunkInput } from "./code-chunks.repository";
import { mapWithConcurrency } from "./concurrency";
import { embedInBatches } from "./embedding/embedding-batcher";
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from "./embedding/embedding-provider";
import { EmbeddingRunsRepository } from "./embedding-runs.repository";
import { ManifestReaderService, type Manifest, type ManifestFileEntry } from "./manifest-reader.service";
import { SnapshotChunksRepository, type InsertSnapshotChunkInput } from "./snapshot-chunks.repository";

interface ChunkCandidate {
  contentHash: string;
  fileId: string;
  spec: ChunkSpec;
  path: string;
  language: string | null;
}

/**
 * Reacts to `repo.index.requested` (SEARCH_EMBEDDING_SERVICE_PLAN.md "Flow
 * Chart"). Unchanged files (same path, same file-level content hash as the
 * repo's previous snapshot) are relinked from the previous snapshot's
 * chunks with zero chunking and zero embedding calls; changed/new files are
 * chunked, deduplicated by per-chunk content hash against everything
 * already stored for this repo, and only genuinely new content is embedded.
 */
@Injectable()
export class IndexingService {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: AiEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
    private readonly manifestReader: ManifestReaderService,
    private readonly codeChunks: CodeChunksRepository,
    private readonly snapshotChunks: SnapshotChunksRepository,
    private readonly embeddingRuns: EmbeddingRunsRepository
  ) {}

  async handleIndexRequested(envelope: TypedEnvelope<"repo.index.requested">): Promise<void> {
    const repoId = this.requireRepoId(envelope);
    const snapshotId = this.requireSnapshotId(envelope);
    const startedAt = Date.now();

    await this.embeddingRuns.upsertRunning({ id: randomUUID(), repoId, snapshotId });

    try {
      const manifest = await this.manifestReader.readManifest(envelope.payload.manifestKey);
      const previousManifest = envelope.payload.previousSnapshotId
        ? await this.tryReadPreviousManifest(repoId, envelope.payload.previousSnapshotId)
        : null;

      const { unchangedFiles, changedFiles } = diffAgainstPrevious(manifest, previousManifest?.manifest ?? null);

      if (unchangedFiles.length > 0 && previousManifest) {
        await this.relinkUnchangedFiles(snapshotId, previousManifest.snapshotId, unchangedFiles);
      }

      const { embeddedChunks, promptTokens } = await this.chunkAndEmbedChangedFiles(repoId, snapshotId, changedFiles);

      const totalChunks = await this.snapshotChunks.countBySnapshot(snapshotId);
      const reusedChunks = Math.max(totalChunks - embeddedChunks, 0);

      await this.embeddingRuns.markCompleted({ snapshotId, totalChunks, embeddedChunks, reusedChunks, promptTokens });

      await publishJob(this.boss, {
        eventType: "repo.embeddings.completed",
        payload: {
          commitSha: envelope.payload.commitSha,
          chunkCount: totalChunks,
          embeddedCount: embeddedChunks,
          reusedCount: reusedChunks,
          promptTokens,
          embeddingModel: this.embeddingProvider.model,
          stage: "embedding",
          batchIndex: 0,
          batchCount: 1,
          itemsProcessed: totalChunks,
          totalItems: totalChunks,
          durationMs: Date.now() - startedAt,
        },
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        userId: envelope.userId,
        repoId,
        snapshotId,
      });

      this.logger.info({ repoId, snapshotId, totalChunks, embeddedChunks, reusedChunks }, "embedding run completed");
    } catch (err) {
      await this.handleFailure(envelope, repoId, snapshotId, err);
    }
  }

  private async tryReadPreviousManifest(repoId: string, previousSnapshotId: string): Promise<{ manifest: Manifest; snapshotId: string } | null> {
    try {
      const manifest = await this.manifestReader.readManifest(manifestObjectKey(repoId, previousSnapshotId));
      return { manifest, snapshotId: previousSnapshotId };
    } catch (err) {
      this.logger.warn({ err, repoId, previousSnapshotId }, "could not read previous snapshot's manifest, reindexing everything");
      return null;
    }
  }

  private async relinkUnchangedFiles(
    newSnapshotId: string,
    previousSnapshotId: string,
    unchangedFiles: { oldFileId: string; newFileId: string }[]
  ): Promise<void> {
    const oldFileIdToNew = new Map(unchangedFiles.map((f) => [f.oldFileId, f.newFileId]));
    const previousLinks = await this.snapshotChunks.listBySnapshotAndFileIds(
      previousSnapshotId,
      unchangedFiles.map((f) => f.oldFileId)
    );

    const relinked: InsertSnapshotChunkInput[] = previousLinks
      .map((link) => {
        const newFileId = oldFileIdToNew.get(link.file_id);
        return newFileId ? { snapshotId: newSnapshotId, chunkId: link.chunk_id, fileId: newFileId } : null;
      })
      .filter((x): x is InsertSnapshotChunkInput => x !== null);

    await this.snapshotChunks.insertBatch(relinked);
  }

  private async chunkAndEmbedChangedFiles(
    repoId: string,
    snapshotId: string,
    files: ManifestFileEntry[]
  ): Promise<{ embeddedChunks: number; promptTokens: number }> {
    if (files.length === 0) return { embeddedChunks: 0, promptTokens: 0 };

    const perFileCandidates = await mapWithConcurrency(files, this.config.EMBEDDING_CONCURRENCY, async (file) => {
      const content = await this.manifestReader.readFileContent(file.objectKey);
      const specs = chunkFile(
        { path: file.path, language: file.language, content },
        { maxTokens: this.config.CHUNK_MAX_TOKENS, overlapTokens: this.config.CHUNK_OVERLAP_TOKENS }
      );
      return specs.map(
        (spec): ChunkCandidate => ({
          contentHash: contentHashOf(spec.content),
          fileId: file.fileId,
          spec,
          path: file.path,
          language: file.language,
        })
      );
    });
    const candidates = perFileCandidates.flat();
    if (candidates.length === 0) return { embeddedChunks: 0, promptTokens: 0 };

    // Dedup by content hash within this run too — two files (or two spots in
    // one file) can legitimately produce byte-identical chunk content.
    const firstByHash = new Map<string, ChunkCandidate>();
    for (const candidate of candidates) {
      if (!firstByHash.has(candidate.contentHash)) firstByHash.set(candidate.contentHash, candidate);
    }

    const existing = await this.codeChunks.findExistingByContentHashes(repoId, [...firstByHash.keys()]);
    const toEmbed = [...firstByHash.values()].filter((c) => !existing.has(c.contentHash));

    const embeddingResults =
      toEmbed.length > 0
        ? await embedInBatches({
            provider: this.embeddingProvider,
            texts: toEmbed.map((c) => c.spec.content),
            batchSize: this.config.EMBEDDING_BATCH_SIZE,
            concurrency: this.config.EMBEDDING_CONCURRENCY,
            logger: this.logger,
          })
        : [];

    const chunkIdByHash = new Map<string, string>();
    for (const [hash, row] of existing) chunkIdByHash.set(hash, row.id);

    const newRows: InsertCodeChunkInput[] = toEmbed.map((candidate, i) => {
      const id = randomUUID();
      chunkIdByHash.set(candidate.contentHash, id);
      const result = embeddingResults[i]!;
      return {
        id,
        repoId,
        contentHash: candidate.contentHash,
        path: candidate.path,
        startLine: candidate.spec.startLine,
        endLine: candidate.spec.endLine,
        language: candidate.language,
        symbolName: candidate.spec.symbolName,
        symbolType: candidate.spec.symbolType,
        tokenCount: result.tokenCount,
        content: candidate.spec.content,
        embedding: result.embedding,
        embeddingModel: this.embeddingProvider.model,
      };
    });
    await this.codeChunks.insertBatch(newRows);

    const links: InsertSnapshotChunkInput[] = candidates.map((candidate) => ({
      snapshotId,
      chunkId: chunkIdByHash.get(candidate.contentHash)!,
      fileId: candidate.fileId,
    }));
    await this.snapshotChunks.insertBatch(links);

    const promptTokens = embeddingResults.reduce((sum, r) => sum + r.tokenCount, 0);
    return { embeddedChunks: toEmbed.length, promptTokens };
  }

  private async handleFailure(envelope: TypedEnvelope<"repo.index.requested">, repoId: string, snapshotId: string, err: unknown): Promise<void> {
    const appError = err instanceof AppError ? err : new AppError("EMBEDDING_FAILED", "Embedding the repository's chunks failed.", { cause: err });

    this.logger.error({ err: appError, repoId, snapshotId }, "embedding run failed");
    await this.embeddingRuns.markFailed(snapshotId, appError.code);

    await publishJob(this.boss, {
      eventType: "repo.stage.failed",
      payload: {
        stage: "embedding",
        errorCode: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        detail: {},
      },
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
      userId: envelope.userId,
      repoId,
      snapshotId,
    });
  }

  private requireRepoId(envelope: { repoId: string | null }): string {
    if (!envelope.repoId) throw new Error("Expected repo.index.requested to carry a repoId");
    return envelope.repoId;
  }

  private requireSnapshotId(envelope: { snapshotId: string | null }): string {
    if (!envelope.snapshotId) throw new Error("Expected repo.index.requested to carry a snapshotId");
    return envelope.snapshotId;
  }
}

function contentHashOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** Pure comparison — no I/O. A file is "unchanged" only if both its path and file-level content hash match between snapshots. */
function diffAgainstPrevious(
  manifest: Manifest,
  previous: Manifest | null
): { unchangedFiles: { oldFileId: string; newFileId: string }[]; changedFiles: ManifestFileEntry[] } {
  if (!previous) return { unchangedFiles: [], changedFiles: manifest.files };

  const previousByPath = new Map(previous.files.map((f) => [f.path, f]));
  const unchangedFiles: { oldFileId: string; newFileId: string }[] = [];
  const changedFiles: ManifestFileEntry[] = [];

  for (const file of manifest.files) {
    const previousFile = previousByPath.get(file.path);
    if (previousFile && previousFile.contentHash === file.contentHash) {
      unchangedFiles.push({ oldFileId: previousFile.fileId, newFileId: file.fileId });
    } else {
      changedFiles.push(file);
    }
  }

  return { unchangedFiles, changedFiles };
}
