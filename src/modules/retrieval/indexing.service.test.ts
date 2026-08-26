import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TypedEnvelope } from "@aca/contracts";
import type { AiEnv } from "../../config/env";
import type { CodeChunkRow, InsertCodeChunkInput } from "./code-chunks.repository";
import type { EmbeddingProvider } from "./embedding/embedding-provider";
import { IndexingService } from "./indexing.service";
import type { Manifest, ManifestFileEntry } from "./manifest-reader.service";
import type { InsertSnapshotChunkInput, SnapshotChunkRow } from "./snapshot-chunks.repository";

const REPO_ID = "123e4567-e89b-12d3-a456-426614174000";
const USER_ID = "123e4567-e89b-12d3-a456-426614174001";
const CORRELATION_ID = "123e4567-e89b-12d3-a456-426614174002";
const EVENT_ID = "123e4567-e89b-12d3-a456-426614174003";
const NEW_SNAPSHOT_ID = "123e4567-e89b-12d3-a456-426614174010";
const PREVIOUS_SNAPSHOT_ID = "123e4567-e89b-12d3-a456-426614174011";

function envelope(overrides: Partial<TypedEnvelope<"repo.index.requested">["payload"]> = {}): TypedEnvelope<"repo.index.requested"> {
  return {
    eventId: EVENT_ID,
    eventType: "repo.index.requested",
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: CORRELATION_ID,
    causationId: null,
    userId: USER_ID,
    repoId: REPO_ID,
    snapshotId: NEW_SNAPSHOT_ID,
    retryCount: 0,
    payload: {
      commitSha: "abc123",
      manifestKey: `${REPO_ID}/${NEW_SNAPSHOT_ID}/manifest.json`,
      previousSnapshotId: null,
      ...overrides,
    },
  };
}

function fileEntry(overrides: Partial<ManifestFileEntry> = {}): ManifestFileEntry {
  const fileId = overrides.fileId ?? randomUUID();
  return {
    fileId,
    path: "src/a.ts",
    language: "typescript",
    sizeBytes: 100,
    lineCount: 5,
    contentHash: "sha256:file-hash",
    objectKey: `${REPO_ID}/${NEW_SNAPSHOT_ID}/files/${fileId}`,
    ...overrides,
  };
}

function manifest(files: ManifestFileEntry[], snapshotId = NEW_SNAPSHOT_ID): Manifest {
  return { repoId: REPO_ID, snapshotId, commitSha: "abc123", generatedAt: new Date().toISOString(), files };
}

function fakeManifestReader(manifests: Record<string, Manifest>, contents: Record<string, string>) {
  return {
    readManifest: vi.fn(async (key: string) => {
      const found = manifests[key];
      if (!found) throw new Error(`no manifest stubbed for key ${key}`);
      return found;
    }),
    readFileContent: vi.fn(async (key: string) => {
      const found = contents[key];
      if (found === undefined) throw new Error(`no content stubbed for key ${key}`);
      return found;
    }),
  };
}

function fakeCodeChunksRepository(seed: CodeChunkRow[] = []) {
  const rows = new Map(seed.map((r) => [`${r.repo_id}:${r.content_hash}`, r]));
  return {
    findExistingByContentHashes: vi.fn(async (repoId: string, hashes: string[]) => {
      const found = new Map<string, CodeChunkRow>();
      for (const hash of hashes) {
        const row = rows.get(`${repoId}:${hash}`);
        if (row) found.set(hash, row);
      }
      return found;
    }),
    insertBatch: vi.fn(async (input: InsertCodeChunkInput[]) => {
      for (const row of input) {
        rows.set(`${row.repoId}:${row.contentHash}`, {
          id: row.id,
          repo_id: row.repoId,
          content_hash: row.contentHash,
          path: row.path,
          start_line: row.startLine,
          end_line: row.endLine,
          language: row.language,
          symbol_name: row.symbolName,
          symbol_type: row.symbolType,
          token_count: row.tokenCount,
          content: row.content,
          embedding_model: row.embeddingModel,
          embedding_version: 1,
          created_at: new Date(),
        });
      }
    }),
    findById: vi.fn(),
    findSimilarForSnapshot: vi.fn(),
    findLexicalForSnapshot: vi.fn(),
  };
}

function fakeSnapshotChunksRepository(seed: SnapshotChunkRow[] = []) {
  const rows: SnapshotChunkRow[] = [...seed];
  return {
    insertBatch: vi.fn(async (input: InsertSnapshotChunkInput[]) => {
      for (const link of input) {
        const exists = rows.some((r) => r.snapshot_id === link.snapshotId && r.chunk_id === link.chunkId);
        if (!exists) rows.push({ snapshot_id: link.snapshotId, chunk_id: link.chunkId, file_id: link.fileId });
      }
    }),
    listBySnapshotAndFileIds: vi.fn(async (snapshotId: string, fileIds: string[]) =>
      rows.filter((r) => r.snapshot_id === snapshotId && fileIds.includes(r.file_id))
    ),
    countBySnapshot: vi.fn(async (snapshotId: string) => rows.filter((r) => r.snapshot_id === snapshotId).length),
    _rows: rows,
  };
}

function fakeEmbeddingRunsRepository() {
  return { upsertRunning: vi.fn(async () => undefined), markCompleted: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined), findBySnapshotId: vi.fn() };
}

function fakeEmbeddingProvider(): EmbeddingProvider & { embedBatch: ReturnType<typeof vi.fn> } {
  return {
    model: "fake-model",
    dimensions: 4,
    embedBatch: vi.fn(async (texts: string[]) => texts.map((t) => ({ embedding: [t.length, 0, 0, 0], tokenCount: t.length }))),
  };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function config(): AiEnv {
  return { CHUNK_MAX_TOKENS: 512, CHUNK_OVERLAP_TOKENS: 64, EMBEDDING_BATCH_SIZE: 96, EMBEDDING_CONCURRENCY: 4 } as AiEnv;
}

function buildService(opts: {
  manifests: Record<string, Manifest>;
  contents: Record<string, string>;
  codeChunksSeed?: CodeChunkRow[];
  snapshotChunksSeed?: SnapshotChunkRow[];
}) {
  const boss = { send: vi.fn().mockResolvedValue("job-1") };
  const manifestReader = fakeManifestReader(opts.manifests, opts.contents);
  const codeChunks = fakeCodeChunksRepository(opts.codeChunksSeed);
  const snapshotChunks = fakeSnapshotChunksRepository(opts.snapshotChunksSeed);
  const embeddingRuns = fakeEmbeddingRunsRepository();
  const embeddingProvider = fakeEmbeddingProvider();
  const logger = fakeLogger();

  const service = new IndexingService(
    boss as never,
    config(),
    logger as never,
    embeddingProvider,
    manifestReader as never,
    codeChunks as never,
    snapshotChunks as never,
    embeddingRuns as never
  );

  return { service, boss, manifestReader, codeChunks, snapshotChunks, embeddingRuns, embeddingProvider, logger };
}

describe("IndexingService.handleIndexRequested", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("makes zero embedding calls when re-indexing an unchanged repository", async () => {
    const fileA = fileEntry({ path: "src/a.ts", contentHash: "sha256:a" });
    const fileB = fileEntry({ path: "src/b.ts", contentHash: "sha256:b" });
    const previousFileA = fileEntry({ fileId: randomUUID(), path: "src/a.ts", contentHash: "sha256:a" });
    const previousFileB = fileEntry({ fileId: randomUUID(), path: "src/b.ts", contentHash: "sha256:b" });

    const newManifestKey = `${REPO_ID}/${NEW_SNAPSHOT_ID}/manifest.json`;
    const previousManifestKey = `${REPO_ID}/${PREVIOUS_SNAPSHOT_ID}/manifest.json`;

    const existingChunkA = "chunk-a";
    const existingChunkB = "chunk-b";

    const { service, boss, manifestReader, embeddingProvider, snapshotChunks } = buildService({
      manifests: {
        [newManifestKey]: manifest([fileA, fileB]),
        [previousManifestKey]: manifest([previousFileA, previousFileB], PREVIOUS_SNAPSHOT_ID),
      },
      contents: {},
      snapshotChunksSeed: [
        { snapshot_id: PREVIOUS_SNAPSHOT_ID, chunk_id: existingChunkA, file_id: previousFileA.fileId },
        { snapshot_id: PREVIOUS_SNAPSHOT_ID, chunk_id: existingChunkB, file_id: previousFileB.fileId },
      ],
    });

    await service.handleIndexRequested(envelope({ manifestKey: newManifestKey, previousSnapshotId: PREVIOUS_SNAPSHOT_ID }));

    expect(manifestReader.readFileContent).not.toHaveBeenCalled();
    expect(embeddingProvider.embedBatch).not.toHaveBeenCalled();

    const newLinks = snapshotChunks._rows.filter((r) => r.snapshot_id === NEW_SNAPSHOT_ID);
    expect(newLinks).toHaveLength(2);
    expect(newLinks.map((l) => l.chunk_id).sort()).toEqual([existingChunkA, existingChunkB].sort());

    const completedCall = boss.send.mock.calls.find((c) => c[0] === "repo.embeddings.completed");
    expect(completedCall?.[1].payload).toMatchObject({ chunkCount: 2, embeddedCount: 0, reusedCount: 2 });
  });

  it("embeds only the changed files' chunks after a mixed change, reusing the unchanged ones", async () => {
    const unchangedFile = fileEntry({ path: "src/unchanged.ts", contentHash: "sha256:same" });
    const previousUnchangedFile = fileEntry({ fileId: randomUUID(), path: "src/unchanged.ts", contentHash: "sha256:same" });
    const changedFile1 = fileEntry({ path: "src/changed1.ts", contentHash: "sha256:new1" });
    const changedFile2 = fileEntry({ path: "src/changed2.ts", contentHash: "sha256:new2" });
    const changedFile3 = fileEntry({ path: "src/changed3.ts", contentHash: "sha256:new3" });

    const previousChangedFile1 = fileEntry({ fileId: randomUUID(), path: "src/changed1.ts", contentHash: "sha256:old1" });

    const newManifestKey = `${REPO_ID}/${NEW_SNAPSHOT_ID}/manifest.json`;
    const previousManifestKey = `${REPO_ID}/${PREVIOUS_SNAPSHOT_ID}/manifest.json`;
    const existingUnchangedChunk = "chunk-unchanged";

    const { service, manifestReader, embeddingProvider } = buildService({
      manifests: {
        [newManifestKey]: manifest([unchangedFile, changedFile1, changedFile2, changedFile3]),
        [previousManifestKey]: manifest([previousUnchangedFile, previousChangedFile1], PREVIOUS_SNAPSHOT_ID),
      },
      contents: {
        [changedFile1.objectKey]: "export function one() { return 1; }",
        [changedFile2.objectKey]: "export function two() { return 2; }",
        [changedFile3.objectKey]: "export function three() { return 3; }",
      },
      snapshotChunksSeed: [{ snapshot_id: PREVIOUS_SNAPSHOT_ID, chunk_id: existingUnchangedChunk, file_id: previousUnchangedFile.fileId }],
    });

    await service.handleIndexRequested(envelope({ manifestKey: newManifestKey, previousSnapshotId: PREVIOUS_SNAPSHOT_ID }));

    // Only the three changed files' content is ever read or embedded.
    expect(manifestReader.readFileContent).toHaveBeenCalledTimes(3);
    const readKeys = manifestReader.readFileContent.mock.calls.map((c) => c[0]).sort();
    expect(readKeys).toEqual([changedFile1.objectKey, changedFile2.objectKey, changedFile3.objectKey].sort());

    const embeddedTexts = embeddingProvider.embedBatch.mock.calls.flatMap((c) => c[0] as string[]);
    expect(embeddedTexts.some((t) => t.includes("function one"))).toBe(true);
    expect(embeddedTexts.some((t) => t.includes("function two"))).toBe(true);
    expect(embeddedTexts.some((t) => t.includes("function three"))).toBe(true);
  });

  it("reuses an already-stored chunk instead of re-embedding identical content", async () => {
    const changedFile = fileEntry({ path: "src/dup.ts", contentHash: "sha256:new" });
    const newManifestKey = `${REPO_ID}/${NEW_SNAPSHOT_ID}/manifest.json`;
    const duplicateContent = "export const x = 1;";

    const { service, embeddingProvider, snapshotChunks } = buildService({
      manifests: { [newManifestKey]: manifest([changedFile]) },
      contents: { [changedFile.objectKey]: duplicateContent },
      codeChunksSeed: [
        {
          id: "existing-chunk-id",
          repo_id: REPO_ID,
          content_hash: `sha256:${createHash("sha256").update(duplicateContent, "utf8").digest("hex")}`,
          path: "src/other.ts",
          start_line: 1,
          end_line: 1,
          language: "typescript",
          symbol_name: "x",
          symbol_type: "variable",
          token_count: 5,
          content: duplicateContent,
          embedding_model: "fake-model",
          embedding_version: 1,
          created_at: new Date(),
        },
      ],
    });

    await service.handleIndexRequested(envelope({ manifestKey: newManifestKey, previousSnapshotId: null }));

    expect(embeddingProvider.embedBatch).not.toHaveBeenCalled();
    const link = snapshotChunks._rows.find((r) => r.snapshot_id === NEW_SNAPSHOT_ID);
    expect(link?.chunk_id).toBe("existing-chunk-id");
  });

  it("publishes repo.stage.failed for the embedding stage and never repo.embeddings.completed when something throws", async () => {
    const newManifestKey = `${REPO_ID}/${NEW_SNAPSHOT_ID}/manifest.json`;
    const { service, boss, embeddingRuns } = buildService({ manifests: {}, contents: {} }); // manifest read will throw: not stubbed

    await service.handleIndexRequested(envelope({ manifestKey: newManifestKey, previousSnapshotId: null }));

    const failedCall = boss.send.mock.calls.find((c) => c[0] === "repo.stage.failed");
    expect(failedCall?.[1].payload).toMatchObject({ stage: "embedding" });
    expect(boss.send.mock.calls.some((c) => c[0] === "repo.embeddings.completed")).toBe(false);
    expect(embeddingRuns.markFailed).toHaveBeenCalledWith(NEW_SNAPSHOT_ID, expect.any(String));
  });

  it("chunks and embeds every file on a first-ever import (no previous snapshot)", async () => {
    const fileA = fileEntry({ path: "src/a.ts" });
    const newManifestKey = `${REPO_ID}/${NEW_SNAPSHOT_ID}/manifest.json`;

    const { service, embeddingProvider, snapshotChunks } = buildService({
      manifests: { [newManifestKey]: manifest([fileA]) },
      contents: { [fileA.objectKey]: "export function hello() { return 'hi'; }" },
    });

    await service.handleIndexRequested(envelope({ manifestKey: newManifestKey, previousSnapshotId: null }));

    expect(embeddingProvider.embedBatch).toHaveBeenCalledTimes(1);
    expect(snapshotChunks._rows.filter((r) => r.snapshot_id === NEW_SNAPSHOT_ID).length).toBeGreaterThan(0);
  });
});
