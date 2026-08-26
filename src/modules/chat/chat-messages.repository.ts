import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { CitationDto } from "@aca/contracts";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";
import { decodeListCursor, encodeListCursor } from "./list-cursor";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: ChatRole;
  content: string;
  citations: CitationDto[];
  snapshot_id: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number | null;
  finish_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface InsertChatMessageInput {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  citations?: CitationDto[];
  snapshotId?: string | null;
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number | null;
  finishReason?: string | null;
}

type MessageCursor = {
  createdAt: string;
  id: string;
};

/** Data access for `chat_messages` (CHAT_SERVICE_PLAN.md "Database Ownership"). */
@Injectable()
export class ChatMessagesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(input: InsertChatMessageInput): Promise<ChatMessageRow> {
    const rows = await query<ChatMessageRow>(
      this.pool,
      `INSERT INTO chat_messages (
         id, conversation_id, role, content, citations, snapshot_id, model, prompt_tokens, completion_tokens, latency_ms, finish_reason
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.id,
        input.conversationId,
        input.role,
        input.content,
        JSON.stringify(input.citations ?? []),
        input.snapshotId ?? null,
        input.model ?? null,
        input.promptTokens ?? 0,
        input.completionTokens ?? 0,
        input.latencyMs ?? null,
        input.finishReason ?? null,
      ]
    );
    return rows[0]!;
  }

  async listByConversation(input: {
    conversationId: string;
    cursor?: string;
    pageSize: number;
  }): Promise<{ rows: ChatMessageRow[]; nextCursor: string | null }> {
    const conditions = ["conversation_id = $1"];
    const values: unknown[] = [input.conversationId];

    if (input.cursor) {
      const decoded = decodeListCursor<MessageCursor>(input.cursor);
      values.push(decoded.createdAt, decoded.id);
      conditions.push(`(created_at, id) > ($${values.length - 1}, $${values.length})`);
    }

    values.push(input.pageSize);
    const rows = await query<ChatMessageRow>(
      this.pool,
      `SELECT * FROM chat_messages WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT $${values.length}`,
      values
    );

    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === input.pageSize && last ? encodeListCursor<MessageCursor>({ createdAt: last.created_at.toISOString(), id: last.id }) : null;

    return { rows, nextCursor };
  }

  /** Most recent `limit` messages in chronological order — the raw material for the prompt's conversation-history block (LLM_PROMPTING.md "Context Assembly Order"). */
  async listRecentChronological(conversationId: string, limit: number): Promise<ChatMessageRow[]> {
    const rows = await query<ChatMessageRow>(
      this.pool,
      `SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit]
    );
    return rows.reverse();
  }
}
