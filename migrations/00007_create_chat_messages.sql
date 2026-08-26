-- migrate:up
-- `citations` is denormalized jsonb, not a link table — citations are a
-- point-in-time record of what the model claimed and what survived
-- validation for THIS message, never queried independently of it
-- (LLM_PROMPTING.md "Citation Rules"). `snapshot_id` records which version of
-- the code the answer was grounded in, so an old answer stays honest after a
-- re-index moves the active snapshot.
CREATE TABLE IF NOT EXISTS chat_messages (
  id                 uuid PRIMARY KEY,
  conversation_id    uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role               text NOT NULL,          -- user | assistant | system
  content            text NOT NULL,
  citations          jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot_id        uuid,
  model              text,
  prompt_tokens      integer NOT NULL DEFAULT 0,
  completion_tokens  integer NOT NULL DEFAULT 0,
  latency_ms         integer,
  finish_reason      text,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
  ON chat_messages (conversation_id, created_at ASC);

-- migrate:down
DROP TABLE IF EXISTS chat_messages;
