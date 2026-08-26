-- migrate:up
-- Which chunks belong to which snapshot — a plain uuid, not a foreign key,
-- since repository_snapshots lives in the indexer's own database
-- (RULES.md "Foreign keys only inside a single database").
CREATE TABLE IF NOT EXISTS snapshot_chunks (
  snapshot_id uuid NOT NULL,
  chunk_id    uuid NOT NULL REFERENCES code_chunks(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL,
  PRIMARY KEY (snapshot_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_chunks_snapshot
  ON snapshot_chunks (snapshot_id);

-- migrate:down
DROP TABLE IF EXISTS snapshot_chunks;
