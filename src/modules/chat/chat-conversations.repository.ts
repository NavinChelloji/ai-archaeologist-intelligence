import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";
import { decodeListCursor, encodeListCursor } from "./list-cursor";

export interface ChatConversationRow {
  id: string;
  user_id: string;
  repo_id: string;
  title: string | null;
  message_count: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

type ConversationCursor = {
  updatedAt: string;
  id: string;
};

/** Data access for `chat_conversations` (CHAT_SERVICE_PLAN.md "Database Ownership"). */
@Injectable()
export class ChatConversationsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(input: { id: string; userId: string; repoId: string; title: string | null }): Promise<ChatConversationRow> {
    const rows = await query<ChatConversationRow>(
      this.pool,
      `INSERT INTO chat_conversations (id, user_id, repo_id, title) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.id, input.userId, input.repoId, input.title]
    );
    return rows[0]!;
  }

  /** Scoped to `userId` too — a conversation belonging to another user reads as not-found, never a 403 that confirms it exists (RULES.md #13). */
  async findByIdForUser(id: string, userId: string): Promise<ChatConversationRow | null> {
    const rows = await query<ChatConversationRow>(
      this.pool,
      `SELECT * FROM chat_conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    );
    return rows[0] ?? null;
  }

  async listByRepoAndUser(input: {
    repoId: string;
    userId: string;
    cursor?: string;
    pageSize: number;
  }): Promise<{ rows: ChatConversationRow[]; nextCursor: string | null }> {
    const conditions = ["repo_id = $1", "user_id = $2", "deleted_at IS NULL"];
    const values: unknown[] = [input.repoId, input.userId];

    if (input.cursor) {
      const decoded = decodeListCursor<ConversationCursor>(input.cursor);
      values.push(decoded.updatedAt, decoded.id);
      conditions.push(`(updated_at, id) < ($${values.length - 1}, $${values.length})`);
    }

    values.push(input.pageSize);
    const rows = await query<ChatConversationRow>(
      this.pool,
      `SELECT * FROM chat_conversations WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`,
      values
    );

    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === input.pageSize && last ? encodeListCursor<ConversationCursor>({ updatedAt: last.updated_at.toISOString(), id: last.id }) : null;

    return { rows, nextCursor };
  }

  async touch(id: string, messageCountDelta: number): Promise<void> {
    await query(this.pool, `UPDATE chat_conversations SET message_count = message_count + $2, updated_at = now() WHERE id = $1`, [
      id,
      messageCountDelta,
    ]);
  }

  async softDelete(id: string, userId: string): Promise<void> {
    await query(this.pool, `UPDATE chat_conversations SET deleted_at = now() WHERE id = $1 AND user_id = $2`, [id, userId]);
  }
}
