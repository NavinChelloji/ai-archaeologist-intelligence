import { z } from "zod";
import { backendBaseEnvShape, booleanFromString, loadEnv, portSchema, urlSchema } from "@aca/config";

const AiEnvSchema = z.object({
  ...backendBaseEnvShape,
  PORT: portSchema.default(3200),
  AI_DATABASE_URL: urlSchema,

  // Object storage — same shape as the indexer's (SEARCH_EMBEDDING_SERVICE_PLAN.md
  // "ai reads the S3 manifest and per-file text using the snapshot manifest").
  S3_ENDPOINT: urlSchema,
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  S3_FORCE_PATH_STYLE: booleanFromString.default(true),

  // SCOPE_LIMITS.md "Retrieval and Embedding Limits". EMBEDDING_DIMENSIONS is
  // deliberately absent — pgvector fixes column width at DDL time, so the
  // model (and its dimensionality) is pinned in the migration, not env-configurable.
  CHUNK_MAX_TOKENS: z.coerce.number().int().positive().default(512),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().nonnegative().default(64),
  EMBEDDING_MODEL: z.string().default("Xenova/all-MiniLM-L6-v2"),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(96),
  EMBEDDING_CONCURRENCY: z.coerce.number().int().positive().default(4),
  RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(40),
  RETRIEVAL_FINAL_K: z.coerce.number().int().positive().default(16),
  RETRIEVAL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.25),

  // `ai` calls `indexer`'s internal API directly for citation validation and
  // graph summaries (CHAT_SERVICE_PLAN.md) — a deployable-to-deployable call
  // that never goes through `api`, minted with its own iss:ai internal token.
  INDEXER_SERVICE_URL: urlSchema,

  // Chat module (Stage 9 — CHAT_SERVICE_PLAN.md "Environment Variables").
  LLM_PROVIDER: z.string().default("groq"),
  LLM_API_KEY: z.string().min(1),
  CHAT_MODEL: z.string().min(1),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  FIRST_TOKEN_TARGET_MS: z.coerce.number().int().positive().default(2000),
  MAX_CONTEXT_CHUNKS: z.coerce.number().int().positive().default(16),
  MAX_CONTEXT_TOKENS: z.coerce.number().int().positive().default(12000),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().positive().default(10),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2000),
  CHAT_QUOTA_TOKENS_PER_MONTH: z.coerce.number().int().positive().default(500000),
});

export type AiEnv = z.infer<typeof AiEnvSchema>;

export function loadAiEnv(): AiEnv {
  return loadEnv(AiEnvSchema);
}
