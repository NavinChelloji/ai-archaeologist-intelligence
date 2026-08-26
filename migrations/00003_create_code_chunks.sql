-- migrate:up
-- Keyed on (repo_id, content_hash), not (snapshot_id, ...) — SEARCH_EMBEDDING_SERVICE_PLAN.md
-- "Embedding Reuse": re-indexing an unchanged repo must make zero new embedding
-- calls, so a chunk's identity is its content, not the snapshot it happened to
-- first appear in. `embedding` is vector(384) for Xenova/all-MiniLM-L6-v2 (the
-- local Transformers.js model this deployment uses) — the plan doc's own example
-- schema assumes OpenAI's text-embedding-3-small (1536-dim); pgvector fixes
-- column width at DDL time, so this is pinned to whichever model is actually
-- configured, recorded per-row in embedding_model for future migration.
CREATE TABLE IF NOT EXISTS code_chunks (
  id                uuid PRIMARY KEY,
  repo_id           uuid NOT NULL,
  content_hash      text NOT NULL,
  path              text NOT NULL,
  start_line        integer NOT NULL,
  end_line          integer NOT NULL,
  language          text,
  symbol_name       text,
  symbol_type       text,
  token_count       integer NOT NULL DEFAULT 0,
  content           text NOT NULL,
  embedding         vector(384) NOT NULL,
  embedding_model   text NOT NULL,
  embedding_version integer NOT NULL DEFAULT 1,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_code_chunks_repo
  ON code_chunks (repo_id);
CREATE INDEX IF NOT EXISTS idx_code_chunks_path
  ON code_chunks (repo_id, path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_symbol
  ON code_chunks (repo_id, lower(symbol_name));
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding
  ON code_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- migrate:down
DROP TABLE IF EXISTS code_chunks;
