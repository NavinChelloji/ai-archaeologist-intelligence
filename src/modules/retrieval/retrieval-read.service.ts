import { Inject, Injectable } from "@nestjs/common";
import { AppError, type ChunkDto, type RetrieveRequest, type RetrieveResponse, type SearchRequest, type SearchResponse } from "@aca/contracts";
import { APP_CONFIG } from "../../config/config.module";
import type { AiEnv } from "../../config/env";
import { CodeChunksRepository, type CodeChunkRow, type ScoredChunkRow } from "./code-chunks.repository";
import { EmbeddingRunsRepository } from "./embedding-runs.repository";
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from "./embedding/embedding-provider";

/** A lexical match (query names a file/class/function) is treated as maximally relevant — SEARCH_EMBEDDING_SERVICE_PLAN.md "should not depend on the embedding happening to rank it." */
const LEXICAL_MATCH_SCORE = 1;

/**
 * Hybrid retrieval — vector similarity plus lexical/metadata filters, reranked
 * with per-file diversification (SEARCH_EMBEDDING_SERVICE_PLAN.md "Retrieval
 * Strategy"). Every read resolves "which snapshot" itself from this repo's
 * most recently *completed* embedding run — the same "caller only ever
 * names the repository" convention `indexer`'s internal read APIs use for
 * their active snapshot, except here it's `ai`'s own data (no cross-deployable
 * call needed): indexer only cuts a snapshot over to active *after* seeing
 * `repo.embeddings.completed`, so the latest completed run here always
 * matches indexer's active snapshot by construction.
 */
@Injectable()
export class RetrievalReadService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AiEnv,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
    private readonly codeChunks: CodeChunksRepository,
    private readonly embeddingRuns: EmbeddingRunsRepository
  ) {}

  async retrieve(repoId: string, request: RetrieveRequest): Promise<RetrieveResponse> {
    const snapshotId = await this.resolveSnapshotId(repoId);
    if (!snapshotId) return { chunks: [], totalCandidates: 0, snapshotId: null };

    const topK = request.topK ?? this.config.RETRIEVAL_TOP_K;
    const [embedded] = await this.embeddingProvider.embedBatch([request.query]);

    const [vectorCandidates, lexicalCandidates] = await Promise.all([
      this.codeChunks.findSimilarForSnapshot({ snapshotId, embedding: embedded!.embedding, limit: topK, filters: request.filters }),
      this.codeChunks.findLexicalForSnapshot({ snapshotId, q: request.query, limit: topK, filters: request.filters }),
    ]);

    const merged = mergeCandidates(vectorCandidates, lexicalCandidates);
    const aboveThreshold = merged.filter((c) => c.score >= this.config.RETRIEVAL_MIN_SCORE);
    const diversified = diversifyByFile(aboveThreshold, this.config.RETRIEVAL_FINAL_K);

    return { chunks: diversified.map((c) => toChunkDto(c, c.score)), totalCandidates: merged.length, snapshotId };
  }

  async search(repoId: string, request: SearchRequest): Promise<SearchResponse> {
    const snapshotId = await this.resolveSnapshotId(repoId);
    if (!snapshotId) return { chunks: [], totalCandidates: 0, snapshotId: null };

    const limit = request.topK ?? this.config.RETRIEVAL_TOP_K;
    const rows = await this.codeChunks.findLexicalForSnapshot({ snapshotId, q: request.q, limit, filters: request.filters });

    return { chunks: rows.map((r) => toChunkDto(r, LEXICAL_MATCH_SCORE)), totalCandidates: rows.length, snapshotId };
  }

  async getChunkById(chunkId: string): Promise<ChunkDto> {
    const row = await this.codeChunks.findById(chunkId);
    if (!row) throw new AppError("NOT_FOUND", "This chunk does not exist.");
    return toChunkDto(row, 1);
  }

  private async resolveSnapshotId(repoId: string): Promise<string | null> {
    const run = await this.embeddingRuns.findLatestCompletedByRepoId(repoId);
    return run?.snapshot_id ?? null;
  }
}

function toChunkDto(row: CodeChunkRow, score: number): ChunkDto {
  return {
    chunkId: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    symbolName: row.symbol_name,
    symbolType: row.symbol_type,
    language: row.language,
    score,
    content: row.content,
  };
}

function mergeCandidates(vector: ScoredChunkRow[], lexical: CodeChunkRow[]): ScoredChunkRow[] {
  const byId = new Map<string, ScoredChunkRow>();
  for (const row of vector) byId.set(row.id, row);
  for (const row of lexical) {
    const existing = byId.get(row.id);
    if (existing) {
      existing.score = Math.max(existing.score, LEXICAL_MATCH_SCORE);
    } else {
      byId.set(row.id, { ...row, score: LEXICAL_MATCH_SCORE });
    }
  }
  return [...byId.values()];
}

/** Round-robins by rank-within-file so no single file can occupy every slot before every other file gets a turn — SEARCH_EMBEDDING_SERVICE_PLAN.md "per-file diversification." */
function diversifyByFile(candidates: ScoredChunkRow[], limit: number): ScoredChunkRow[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const byFile = new Map<string, ScoredChunkRow[]>();
  for (const c of sorted) {
    const list = byFile.get(c.path) ?? [];
    list.push(c);
    byFile.set(c.path, list);
  }

  const files = [...byFile.keys()];
  const result: ScoredChunkRow[] = [];
  let round = 0;
  while (result.length < limit) {
    let addedThisRound = false;
    for (const file of files) {
      const list = byFile.get(file)!;
      if (round < list.length) {
        result.push(list[round]!);
        addedThisRound = true;
        if (result.length >= limit) break;
      }
    }
    if (!addedThisRound) break;
    round += 1;
  }
  return result;
}
