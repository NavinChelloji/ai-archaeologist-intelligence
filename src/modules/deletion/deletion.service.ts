import { Inject, Injectable } from "@nestjs/common";
import type { Logger } from "@aca/logger";
import { APP_LOGGER } from "../../shared/infra.module";
import { ChatConversationsRepository } from "../chat/chat-conversations.repository";
import { CodeChunksRepository } from "../retrieval/code-chunks.repository";
import { EmbeddingRunsRepository } from "../retrieval/embedding-runs.repository";
import { TokenUsageRepository } from "../usage/token-usage.repository";
import { TOMBSTONE_USER_ID } from "../usage/tombstone";

/**
 * Cleanup for `repo.deleted` and `user.deleted` on `ai`'s own tables
 * (DATA_RETENTION_AND_PRIVACY.md "Deletion" step 3: "ai deletes
 * snapshot_chunks, orphaned code_chunks, conversations, and messages for the
 * repository"). Every step is idempotent so retried delivery is safe.
 */
@Injectable()
export class DeletionService {
  constructor(
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly conversations: ChatConversationsRepository,
    private readonly embeddingRuns: EmbeddingRunsRepository,
    private readonly codeChunks: CodeChunksRepository,
    private readonly tokenUsage: TokenUsageRepository
  ) {}

  /** `chat_messages` and `snapshot_chunks` are removed for free via `ON DELETE CASCADE` off `chat_conversations`/`code_chunks`. */
  async deleteRepositoryData(repoId: string): Promise<void> {
    await this.conversations.deleteByRepoId(repoId);
    await this.embeddingRuns.deleteByRepoId(repoId);
    await this.codeChunks.deleteByRepoId(repoId);
    this.logger.info({ repoId }, "ai repository data deleted");
  }

  async deleteForUser(userId: string, repoIds: readonly string[]): Promise<void> {
    for (const repoId of repoIds) {
      await this.deleteRepositoryData(repoId);
    }
    await this.tokenUsage.anonymizeUser(userId, TOMBSTONE_USER_ID);
    this.logger.info({ userId, repoCount: repoIds.length }, "ai account data deleted");
  }
}
