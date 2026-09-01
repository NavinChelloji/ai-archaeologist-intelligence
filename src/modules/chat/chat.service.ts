import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  AppError,
  type ChatCitationEvent,
  type ChatDoneEvent,
  type ChatErrorEvent,
  type ChatTokenEvent,
  type ChatUsageEvent,
  type ConversationDto,
  type ConversationsListResponse,
  type MessageDto,
  type MessagesListResponse,
} from "@aca/contracts";
import type { Logger } from "@aca/logger";
import type { ProviderMetrics } from "@aca/metrics";
import { APP_CONFIG } from "../../config/config.module";
import type { AiEnv } from "../../config/env";
import { APP_LOGGER } from "../../shared/infra.module";
import { PROVIDER_METRICS } from "../../shared/metrics/metrics.module";
import { RetrievalReadService } from "../retrieval/retrieval-read.service";
import { ChatConversationsRepository, type ChatConversationRow } from "./chat-conversations.repository";
import { ChatMessagesRepository, type ChatMessageRow } from "./chat-messages.repository";
import { CitationValidatorService } from "./citation-validator.service";
import { GraphSummaryService } from "./graph-summary.service";
import { LLM_PROVIDER_TOKEN, type LlmProvider } from "./llm/llm-provider";
import { buildPrompt, type HistoryMessage } from "./prompt-builder";
import { classifyQuestion } from "./question-classifier";
import { RepositorySummaryService } from "./repository-summary.service";
import { TokenUsageRepository } from "../usage/token-usage.repository";

export type ChatStreamEvent =
  | { event: "token"; data: ChatTokenEvent }
  | { event: "citation"; data: ChatCitationEvent }
  | { event: "usage"; data: ChatUsageEvent }
  | { event: "done"; data: ChatDoneEvent }
  | { event: "error"; data: ChatErrorEvent };

export interface PreparedMessageContext {
  conversation: ChatConversationRow;
  userId: string;
  question: string;
  /** Prior turns only — fetched before the new user message was stored, so it never includes itself. */
  history: HistoryMessage[];
}

function toConversationDto(row: ChatConversationRow): ConversationDto {
  return {
    conversationId: row.id,
    repoId: row.repo_id,
    title: row.title,
    messageCount: row.message_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMessageDto(row: ChatMessageRow): MessageDto {
  return {
    messageId: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    citations: row.citations,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    latencyMs: row.latency_ms,
    finishReason: row.finish_reason,
    createdAt: row.created_at.toISOString(),
  };
}

function toHistoryMessage(row: ChatMessageRow): HistoryMessage {
  return { role: row.role === "assistant" ? "assistant" : "user", content: row.content };
}

/**
 * Orchestrates chat conversations and the grounded, streamed answer
 * pipeline (CHAT_SERVICE_PLAN.md "Flow Chart"). Split into a pre-flight
 * phase (`prepareUserMessage`, can throw before any HTTP response is
 * committed) and a streaming phase (`streamAssistantReply`, an async
 * generator whose failures become an `error` SSE event instead of an
 * exception, since by then a 200 has already been sent) — the same
 * before/after-headers split `JobEventsStreamService` uses for indexing
 * progress.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AiEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider,
    @Inject(PROVIDER_METRICS) private readonly providerMetrics: ProviderMetrics,
    private readonly conversations: ChatConversationsRepository,
    private readonly messages: ChatMessagesRepository,
    private readonly tokenUsage: TokenUsageRepository,
    private readonly retrieval: RetrievalReadService,
    private readonly repositorySummary: RepositorySummaryService,
    private readonly graphSummary: GraphSummaryService,
    private readonly citationValidator: CitationValidatorService
  ) {}

  async createConversation(repoId: string, userId: string, title?: string): Promise<ConversationDto> {
    const row = await this.conversations.insert({ id: randomUUID(), userId, repoId, title: title ?? null });
    return toConversationDto(row);
  }

  async listConversations(repoId: string, userId: string, cursor: string | undefined, pageSize: number): Promise<ConversationsListResponse> {
    const { rows, nextCursor } = await this.conversations.listByRepoAndUser({ repoId, userId, cursor, pageSize });
    return { conversations: rows.map(toConversationDto), nextCursor };
  }

  async listMessages(conversationId: string, userId: string, cursor: string | undefined, pageSize: number): Promise<MessagesListResponse> {
    await this.assertConversationOwnership(conversationId, userId);
    const { rows, nextCursor } = await this.messages.listByConversation({ conversationId, cursor, pageSize });
    return { messages: rows.map(toMessageDto), nextCursor };
  }

  async deleteConversation(conversationId: string, userId: string): Promise<void> {
    await this.assertConversationOwnership(conversationId, userId);
    await this.conversations.softDelete(conversationId, userId);
  }

  /**
   * Everything that can fail before the SSE response starts: ownership,
   * quota, and storing the user's message. Must run — and throw, if it's
   * going to — before the controller writes any HTTP header.
   */
  async prepareUserMessage(input: { conversationId: string; userId: string; content: string }): Promise<PreparedMessageContext> {
    const conversation = await this.assertConversationOwnership(input.conversationId, input.userId);

    const usedTokens = await this.tokenUsage.sumTokensForUserThisMonth(input.userId, "chat");
    if (usedTokens >= this.config.CHAT_QUOTA_TOKENS_PER_MONTH) {
      throw new AppError("QUOTA_CHAT_TOKENS", "Monthly chat token budget exhausted.");
    }

    const historyLimit = this.config.MAX_HISTORY_MESSAGES * 2;
    const priorMessages = await this.messages.listRecentChronological(conversation.id, historyLimit);
    const history = priorMessages.filter((m) => m.role !== "system").map(toHistoryMessage);

    await this.messages.insert({ id: randomUUID(), conversationId: conversation.id, role: "user", content: input.content });
    await this.conversations.touch(conversation.id, 1);

    return { conversation, userId: input.userId, question: input.content, history };
  }

  /** The grounded-answer pipeline itself — retrieval, prompt assembly, streaming, citation validation, and persistence. Never throws; failures become an `error` event. */
  async *streamAssistantReply(ctx: PreparedMessageContext, correlationId: string): AsyncGenerator<ChatStreamEvent> {
    const startedAt = Date.now();
    const repoId = ctx.conversation.repo_id;

    try {
      const classification = classifyQuestion(ctx.question);

      const [retrieval, repositorySummary] = await Promise.all([
        this.retrieval.retrieve(repoId, {
          query: ctx.question,
          topK: this.config.RETRIEVAL_TOP_K,
          filters: classification.filters,
        }),
        this.repositorySummary.build(repoId),
      ]);

      const graphSummary = await this.buildGraphSummaryIfRelevant(repoId, classification);

      const prompt = buildPrompt({
        repositorySummary,
        graphSummary,
        chunks: retrieval.chunks,
        history: ctx.history,
        question: ctx.question,
        maxContextTokens: this.config.MAX_CONTEXT_TOKENS,
        maxHistoryMessages: this.config.MAX_HISTORY_MESSAGES,
      });

      const stream = this.llm.streamChatCompletion({ messages: prompt.messages, maxOutputTokens: this.config.MAX_OUTPUT_TOKENS });

      let assembled = "";
      for await (const delta of stream.chunks) {
        assembled += delta;
        yield { event: "token", data: { delta } };
      }

      const usage = await stream.usage;
      const citations = await this.citationValidator.validate(repoId, assembled, prompt.usedChunks);
      for (const citation of citations) {
        yield { event: "citation", data: citation };
      }
      yield { event: "usage", data: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } };

      const assistantMessage = await this.messages.insert({
        id: randomUUID(),
        conversationId: ctx.conversation.id,
        role: "assistant",
        content: assembled,
        citations,
        snapshotId: retrieval.snapshotId,
        model: this.llm.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        latencyMs: Date.now() - startedAt,
        finishReason: usage.finishReason,
      });
      await this.conversations.touch(ctx.conversation.id, 1);
      await this.tokenUsage.insert({
        id: randomUUID(),
        userId: ctx.userId,
        repoId,
        kind: "chat",
        model: this.llm.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
      this.providerMetrics.chatLatencySeconds.observe((Date.now() - startedAt) / 1000);

      yield { event: "done", data: { messageId: assistantMessage.id } };
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError("LLM_PROVIDER_ERROR", "Something went wrong while generating the answer.", { cause: err });
      this.logger.error({ err: appErr, conversationId: ctx.conversation.id, correlationId }, "chat stream failed");
      this.providerMetrics.providerErrorsTotal.inc({ provider: this.config.LLM_PROVIDER, kind: appErr.code });
      yield { event: "error", data: { code: appErr.code, correlationId } };
    }
  }

  private async buildGraphSummaryIfRelevant(
    repoId: string,
    classification: ReturnType<typeof classifyQuestion>
  ): Promise<string | null> {
    if (classification.questionClass === "architecture") {
      return this.graphSummary.buildArchitectureSummary(repoId);
    }
    if (classification.questionClass === "change" && classification.targetPath) {
      return this.graphSummary.buildImportersSummary(repoId, classification.targetPath);
    }
    return null;
  }

  private async assertConversationOwnership(conversationId: string, userId: string): Promise<ChatConversationRow> {
    const conversation = await this.conversations.findByIdForUser(conversationId, userId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "This conversation does not exist.");
    return conversation;
  }
}
