-- migrate:up
-- One row per chat turn (kind = 'chat') or embedding run (kind = 'embedding',
-- reserved for a future migration of Stage 8's own accounting onto this
-- table). Recorded even for failed/timed-out requests so cost is never
-- silently unaccounted for (CHAT_SERVICE_PLAN.md "Testing": "Token usage
-- recorded accurately for both streamed and failed requests").
CREATE TABLE IF NOT EXISTS token_usage (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL,
  repo_id            uuid,
  kind               text NOT NULL,          -- embedding | chat
  model              text NOT NULL,
  prompt_tokens      integer NOT NULL DEFAULT 0,
  completion_tokens  integer NOT NULL DEFAULT 0,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_month
  ON token_usage (user_id, occurred_at DESC);

-- migrate:down
DROP TABLE IF EXISTS token_usage;
