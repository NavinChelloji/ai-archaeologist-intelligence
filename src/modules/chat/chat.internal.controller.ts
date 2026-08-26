import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  InternalConversationActionQuerySchema,
  InternalConversationsListQuerySchema,
  InternalCreateConversationRequestSchema,
  InternalMessagesListQuerySchema,
  InternalSendMessageRequestSchema,
  type ConversationDto,
  type ConversationsListResponse,
  type InternalConversationActionQuery,
  type InternalConversationsListQuery,
  type InternalCreateConversationRequest,
  type InternalMessagesListQuery,
  type InternalSendMessageRequest,
  type MessagesListResponse,
} from "@aca/contracts";
import { InternalAuthGuard } from "../../internal/internal-auth.guard";
import { ZodValidationPipe } from "../../shared/validation/zod-validation.pipe";
import { ChatService } from "./chat.service";

/**
 * `/internal/*` — never routed from the public ingress, always behind
 * InternalAuthGuard (RULES.md #12). `api` is the only caller
 * (CHAT_SERVICE_PLAN.md "APIs"). Unlike the public gateway's SSE routes,
 * there is no CORS handling here — this is a server-to-server call, never a
 * browser one.
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class ChatInternalController {
  constructor(private readonly chat: ChatService) {}

  @Post("repositories/:repoId/conversations")
  async createConversation(
    @Param("repoId") repoId: string,
    @Body(new ZodValidationPipe(InternalCreateConversationRequestSchema)) body: InternalCreateConversationRequest
  ): Promise<ConversationDto> {
    return this.chat.createConversation(repoId, body.userId, body.title);
  }

  @Get("repositories/:repoId/conversations")
  async listConversations(
    @Param("repoId") repoId: string,
    @Query(new ZodValidationPipe(InternalConversationsListQuerySchema)) query: InternalConversationsListQuery
  ): Promise<ConversationsListResponse> {
    return this.chat.listConversations(repoId, query.userId, query.cursor, query.pageSize);
  }

  @Get("conversations/:conversationId/messages")
  async listMessages(
    @Param("conversationId") conversationId: string,
    @Query(new ZodValidationPipe(InternalMessagesListQuerySchema)) query: InternalMessagesListQuery
  ): Promise<MessagesListResponse> {
    return this.chat.listMessages(conversationId, query.userId, query.cursor, query.pageSize);
  }

  @Delete("conversations/:conversationId")
  async deleteConversation(
    @Param("conversationId") conversationId: string,
    @Query(new ZodValidationPipe(InternalConversationActionQuerySchema)) query: InternalConversationActionQuery
  ): Promise<{ deleted: true }> {
    await this.chat.deleteConversation(conversationId, query.userId);
    return { deleted: true };
  }

  /**
   * SSE — mirrors JobEventsStreamService's before/after-headers split: the
   * pre-flight (`prepareUserMessage`, ownership + quota + storing the user's
   * message) runs and can throw *before* any header is written, so NestJS's
   * exception filter can still set a real status code for it. Everything
   * after `writeHead` cannot throw an AppError the filter would catch — the
   * generator itself turns failures into an `error` SSE event.
   */
  @Post("conversations/:conversationId/messages")
  async sendMessage(
    @Req() request: FastifyRequest,
    @Param("conversationId") conversationId: string,
    @Body(new ZodValidationPipe(InternalSendMessageRequestSchema)) body: InternalSendMessageRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const prepared = await this.chat.prepareUserMessage({ conversationId, userId: body.userId, content: body.content });

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    try {
      for await (const evt of this.chat.streamAssistantReply(prepared, request.correlationId)) {
        reply.raw.write(`event: ${evt.event}\n`);
        reply.raw.write(`data: ${JSON.stringify(evt.data)}\n\n`);
      }
    } finally {
      reply.raw.end();
    }
  }
}
