import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export type EmbeddingRunStatus = "running" | "completed" | "failed";

export interface EmbeddingRunRow {
  id: string;
  repo_id: string;
  snapshot_id: string;
  status: EmbeddingRunStatus;
  total_chunks: number;
  embedded_chunks: number;
  reused_chunks: number;
  prompt_tokens: number;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Data access for `embedding_runs` — internal cost/reuse telemetry only,
 * never a source of user-visible progress (SEARCH_EMBEDDING_SERVICE_PLAN.md
 * "Database Ownership"). One row per snapshot; a retried run upserts the
 * same row rather than accumulating duplicates.
 */
@Injectable()
export class EmbeddingRunsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async upsertRunning(input: { id: string; repoId: string; snapshotId: string }): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO embedding_runs (id, repo_id, snapshot_id, status)
       VALUES ($1, $2, $3, 'running')
       ON CONFLICT (snapshot_id) DO UPDATE SET status = 'running', updated_at = now()`,
      [input.id, input.repoId, input.snapshotId]
    );
  }

  async markCompleted(input: {
    snapshotId: string;
    totalChunks: number;
    embeddedChunks: number;
    reusedChunks: number;
    promptTokens: number;
  }): Promise<void> {
    await query(
      this.pool,
      `UPDATE embedding_runs
       SET status = 'completed', total_chunks = $2, embedded_chunks = $3, reused_chunks = $4, prompt_tokens = $5, updated_at = now()
       WHERE snapshot_id = $1`,
      [input.snapshotId, input.totalChunks, input.embeddedChunks, input.reusedChunks, input.promptTokens]
    );
  }

  async markFailed(snapshotId: string, errorCode: string): Promise<void> {
    await query(this.pool, `UPDATE embedding_runs SET status = 'failed', error_code = $2, updated_at = now() WHERE snapshot_id = $1`, [
      snapshotId,
      errorCode,
    ]);
  }

  async findBySnapshotId(snapshotId: string): Promise<EmbeddingRunRow | null> {
    const rows = await query<EmbeddingRunRow>(this.pool, "SELECT * FROM embedding_runs WHERE snapshot_id = $1", [snapshotId]);
    return rows[0] ?? null;
  }

  /**
   * Retrieval's "which snapshot" resolution (RetrievalReadService) — the
   * most recently completed run for a repo is always the one indexer has
   * cut over to active, since cutover only happens after
   * `repo.embeddings.completed` (CODEBASE.md "One active snapshot per
   * repository"). Returns null if this repo has never finished indexing.
   */
  async findLatestCompletedByRepoId(repoId: string): Promise<EmbeddingRunRow | null> {
    const rows = await query<EmbeddingRunRow>(
      this.pool,
      "SELECT * FROM embedding_runs WHERE repo_id = $1 AND status = 'completed' ORDER BY updated_at DESC LIMIT 1",
      [repoId]
    );
    return rows[0] ?? null;
  }
}
