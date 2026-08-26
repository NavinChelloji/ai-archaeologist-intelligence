import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export type TokenUsageKind = "chat" | "embedding";

/** Data access for `token_usage` (CHAT_SERVICE_PLAN.md "Database Ownership"). One row per chat turn, recorded even for failed/timed-out requests. */
@Injectable()
export class TokenUsageRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(input: {
    id: string;
    userId: string;
    repoId: string | null;
    kind: TokenUsageKind;
    model: string;
    promptTokens: number;
    completionTokens: number;
  }): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO token_usage (id, user_id, repo_id, kind, model, prompt_tokens, completion_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.id, input.userId, input.repoId, input.kind, input.model, input.promptTokens, input.completionTokens]
    );
  }

  /** Sum of prompt+completion tokens this calendar month, for `CHAT_QUOTA_TOKENS_PER_MONTH` enforcement — checked before any paid call (API_ERROR_CODES.md "Quotas are checked before any paid downstream call"). */
  async sumTokensForUserThisMonth(userId: string, kind: TokenUsageKind): Promise<number> {
    const rows = await query<{ total: string }>(
      this.pool,
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total
       FROM token_usage
       WHERE user_id = $1 AND kind = $2 AND occurred_at >= date_trunc('month', now())`,
      [userId, kind]
    );
    return Number(rows[0]?.total ?? 0);
  }
}
