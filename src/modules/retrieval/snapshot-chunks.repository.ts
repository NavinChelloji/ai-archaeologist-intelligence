import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export interface InsertSnapshotChunkInput {
  snapshotId: string;
  chunkId: string;
  fileId: string;
}

export interface SnapshotChunkRow {
  snapshot_id: string;
  chunk_id: string;
  file_id: string;
}

/** Data access for `snapshot_chunks` — which chunks belong to which snapshot (SEARCH_EMBEDDING_SERVICE_PLAN.md "Database Ownership"). */
@Injectable()
export class SnapshotChunksRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** `ON CONFLICT DO NOTHING` on `(snapshot_id, chunk_id)` — relinking an already-linked chunk (e.g. a retried run) is a no-op, not an error. */
  async insertBatch(rows: InsertSnapshotChunkInput[]): Promise<void> {
    if (rows.length === 0) return;

    const values: unknown[] = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 3;
      values.push(row.snapshotId, row.chunkId, row.fileId);
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });

    await query(
      this.pool,
      `INSERT INTO snapshot_chunks (snapshot_id, chunk_id, file_id)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (snapshot_id, chunk_id) DO NOTHING`,
      values
    );
  }

  /** Used to relink an unchanged file's already-embedded chunks into the new snapshot without re-chunking or re-embedding it. */
  async listBySnapshotAndFileIds(snapshotId: string, fileIds: string[]): Promise<SnapshotChunkRow[]> {
    if (fileIds.length === 0) return [];
    return query<SnapshotChunkRow>(this.pool, "SELECT * FROM snapshot_chunks WHERE snapshot_id = $1 AND file_id = ANY($2)", [
      snapshotId,
      fileIds,
    ]);
  }

  async countBySnapshot(snapshotId: string): Promise<number> {
    const rows = await query<{ count: string }>(this.pool, "SELECT count(*)::text AS count FROM snapshot_chunks WHERE snapshot_id = $1", [
      snapshotId,
    ]);
    return Number(rows[0]?.count ?? "0");
  }

  /**
   * `snapshot.prune` cleanup, first half: removes links to snapshots
   * `indexer` no longer retains for this repo. `ai` has no snapshots table
   * of its own, so `validSnapshotIds` (fetched from `indexer`) is the only
   * source of truth for "still valid" here. An empty `validSnapshotIds`
   * removes every link for the repo, which is correct if `indexer` retains
   * nothing. Scoped to the repo via a join through `code_chunks`, since this
   * table carries no `repo_id` of its own.
   */
  async deleteForRepoNotIn(repoId: string, validSnapshotIds: string[]): Promise<number> {
    const rows = await query<{ chunk_id: string }>(
      this.pool,
      `DELETE FROM snapshot_chunks sc
       USING code_chunks cc
       WHERE sc.chunk_id = cc.id
       AND cc.repo_id = $1
       AND sc.snapshot_id != ALL($2::uuid[])
       RETURNING sc.chunk_id`,
      [repoId, validSnapshotIds]
    );
    return rows.length;
  }
}
