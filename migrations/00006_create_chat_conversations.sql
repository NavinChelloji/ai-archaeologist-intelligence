-- migrate:up
-- `user_id` is a deliberate exception to "ai/indexer tables carry no user_id"
-- (CODEBASE.md): a conversation is inherently user-scoped, and `ai` owns this
-- table outright, so ownership is checked here directly against the userId on
-- the trusted internal token's claims — no round trip to `api` per message
-- (CHAT_SERVICE_PLAN.md "Conversation ownership is enforced").
CREATE TABLE IF NOT EXISTS chat_conversations (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  repo_id       uuid NOT NULL,
  title         text,
  message_count integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_repo_user
  ON chat_conversations (repo_id, user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

-- migrate:down
DROP TABLE IF EXISTS chat_conversations;
