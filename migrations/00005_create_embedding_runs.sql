-- migrate:up
-- Internal cost/reuse telemetry only — SEARCH_EMBEDDING_SERVICE_PLAN.md
-- "explicitly internal telemetry, not a second source of user-visible
-- progress." The Pipeline module in indexer remains the only authority on
-- job status; this answers "how many embeddings did that cost" and makes
-- the reuse rate observable.
CREATE TABLE IF NOT EXISTS embedding_runs (
  id                uuid PRIMARY KEY,
  repo_id           uuid NOT NULL,
  snapshot_id       uuid NOT NULL,
  status            text NOT NULL,
  total_chunks      integer NOT NULL DEFAULT 0,
  embedded_chunks   integer NOT NULL DEFAULT 0,
  reused_chunks     integer NOT NULL DEFAULT 0,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  error_code        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id)
);

-- migrate:down
DROP TABLE IF EXISTS embedding_runs;
