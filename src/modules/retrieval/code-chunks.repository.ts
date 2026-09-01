import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { SymbolType } from "@aca/contracts";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export interface InsertCodeChunkInput {
  id: string;
  repoId: string;
  contentHash: string;
  path: string;
  startLine: number;
  endLine: number;
  language: string | null;
  symbolName: string | null;
  symbolType: SymbolType | null;
  tokenCount: number;
  content: string;
  embedding: number[];
  embeddingModel: string;
}

export interface CodeChunkRow {
  id: string;
  repo_id: string;
  content_hash: string;
  path: string;
  start_line: number;
  end_line: number;
  language: string | null;
  symbol_name: string | null;
  symbol_type: SymbolType | null;
  token_count: number;
  content: string;
  embedding_model: string;
  embedding_version: number;
  created_at: Date;
}

export interface RetrievalFilterInput {
  pathPrefix?: string;
  language?: string;
  symbolType?: SymbolType;
}

export interface ScoredChunkRow extends CodeChunkRow {
  score: number;
}

/** Formats a JS number array as the text pgvector accepts for a `::vector` cast — `pg` has no built-in codec for the `vector` OID. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Data access for `code_chunks` (SEARCH_EMBEDDING_SERVICE_PLAN.md "Database Ownership"). */
@Injectable()
export class CodeChunksRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Reuse lookup — SEARCH_EMBEDDING_SERVICE_PLAN.md "Embedding Reuse": zero new embedding calls for content already stored under this repo. */
  async findExistingByContentHashes(repoId: string, contentHashes: string[]): Promise<Map<string, CodeChunkRow>> {
    if (contentHashes.length === 0) return new Map();
    const rows = await query<CodeChunkRow>(this.pool, "SELECT * FROM code_chunks WHERE repo_id = $1 AND content_hash = ANY($2)", [
      repoId,
      contentHashes,
    ]);
    return new Map(rows.map((r) => [r.content_hash, r]));
  }

  async findById(chunkId: string): Promise<CodeChunkRow | null> {
    const rows = await query<CodeChunkRow>(this.pool, "SELECT * FROM code_chunks WHERE id = $1", [chunkId]);
    return rows[0] ?? null;
  }

  /**
   * `ON CONFLICT DO NOTHING` on `(repo_id, content_hash)` — guards the rare
   * race of two concurrent embedding runs for the same repo (or a revert to
   * previously-seen content) producing the same chunk twice.
   */
  async insertBatch(rows: InsertCodeChunkInput[]): Promise<void> {
    if (rows.length === 0) return;

    const values: unknown[] = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 13;
      values.push(
        row.id,
        row.repoId,
        row.contentHash,
        row.path,
        row.startLine,
        row.endLine,
        row.language,
        row.symbolName,
        row.symbolType,
        row.tokenCount,
        row.content,
        toVectorLiteral(row.embedding),
        row.embeddingModel
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}::vector, $${base + 13})`;
    });

    await query(
      this.pool,
      `INSERT INTO code_chunks (
         id, repo_id, content_hash, path, start_line, end_line, language, symbol_name, symbol_type, token_count, content, embedding, embedding_model
       ) VALUES ${placeholders.join(", ")}
       ON CONFLICT (repo_id, content_hash) DO NOTHING`,
      values
    );
  }

  /**
   * Vector similarity over one snapshot's chunks, joined through
   * `snapshot_chunks` (SEARCH_EMBEDDING_SERVICE_PLAN.md "Retrieval
   * Strategy"). `1 - (embedding <=> query)` turns pgvector's cosine
   * *distance* into a cosine *similarity* score in `[-1, 1]`, matching
   * `RETRIEVAL_MIN_SCORE`'s documented meaning.
   */
  async findSimilarForSnapshot(input: {
    snapshotId: string;
    embedding: number[];
    limit: number;
    filters?: RetrievalFilterInput;
  }): Promise<ScoredChunkRow[]> {
    const conditions = ["sc.snapshot_id = $1"];
    const values: unknown[] = [input.snapshotId, toVectorLiteral(input.embedding)];
    this.appendFilterConditions(conditions, values, input.filters);
    values.push(input.limit);

    return query<ScoredChunkRow>(
      this.pool,
      `SELECT cc.*, 1 - (cc.embedding <=> $2::vector) AS score
       FROM snapshot_chunks sc
       JOIN code_chunks cc ON cc.id = sc.chunk_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY cc.embedding <=> $2::vector
       LIMIT $${values.length}`,
      values
    );
  }

  /** Lexical match on path or symbol name — SEARCH_EMBEDDING_SERVICE_PLAN.md "a question mentioning AuthGuard should not depend on the embedding happening to rank it." */
  async findLexicalForSnapshot(input: { snapshotId: string; q: string; limit: number; filters?: RetrievalFilterInput }): Promise<CodeChunkRow[]> {
    const escaped = input.q.toLowerCase().replace(/[\\%_]/g, "\\$&");
    const conditions = ["sc.snapshot_id = $1", `(lower(cc.path) LIKE $2 ESCAPE '\\' OR lower(cc.symbol_name) LIKE $2 ESCAPE '\\')`];
    const values: unknown[] = [input.snapshotId, `%${escaped}%`];
    this.appendFilterConditions(conditions, values, input.filters);
    values.push(input.limit);

    return query<CodeChunkRow>(
      this.pool,
      `SELECT cc.*
       FROM snapshot_chunks sc
       JOIN code_chunks cc ON cc.id = sc.chunk_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY cc.path ASC
       LIMIT $${values.length}`,
      values
    );
  }

  /** `repo.deleted` cleanup (DATA_RETENTION_AND_PRIVACY.md "ai deletes snapshot_chunks, orphaned code_chunks ... for the repository") — cascades to `snapshot_chunks` via its `chunk_id` FK. Idempotent. */
  async deleteByRepoId(repoId: string): Promise<void> {
    await query(this.pool, "DELETE FROM code_chunks WHERE repo_id = $1", [repoId]);
  }

  /**
   * `snapshot.prune` cleanup, second half: after `snapshot_chunks` rows for
   * pruned snapshots are gone, a chunk with zero remaining links is no
   * longer referenced by any retained snapshot and can be removed
   * (DATA_RETENTION_AND_PRIVACY.md "pruning a snapshot deletes only the
   * chunks no remaining snapshot still references"). Returns the count
   * removed for the handler's log line.
   */
  async deleteOrphaned(repoId: string): Promise<number> {
    const rows = await query<{ id: string }>(
      this.pool,
      `DELETE FROM code_chunks cc
       WHERE cc.repo_id = $1
       AND NOT EXISTS (SELECT 1 FROM snapshot_chunks sc WHERE sc.chunk_id = cc.id)
       RETURNING cc.id`,
      [repoId]
    );
    return rows.length;
  }

  private appendFilterConditions(conditions: string[], values: unknown[], filters?: RetrievalFilterInput): void {
    if (filters?.pathPrefix) {
      const escaped = filters.pathPrefix.replace(/[\\%_]/g, "\\$&");
      values.push(`${escaped}%`);
      conditions.push(`cc.path LIKE $${values.length} ESCAPE '\\'`);
    }
    if (filters?.language) {
      values.push(filters.language);
      conditions.push(`cc.language = $${values.length}`);
    }
    if (filters?.symbolType) {
      values.push(filters.symbolType);
      conditions.push(`cc.symbol_type = $${values.length}`);
    }
  }
}
