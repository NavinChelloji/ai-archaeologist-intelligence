import { Module } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { InternalModule } from "../../internal/internal.module";
import { RetrievalModule } from "../retrieval/retrieval.module";
import { UsageModule } from "../usage/usage.module";
import { ChatConversationsRepository } from "./chat-conversations.repository";
import { ChatInternalController } from "./chat.internal.controller";
import { ChatMessagesRepository } from "./chat-messages.repository";
import { ChatService } from "./chat.service";
import { CitationValidatorService } from "./citation-validator.service";
import { GraphSummaryService } from "./graph-summary.service";
import { IndexerHttpClient } from "./indexer-http.client";
import { GroqLlmProvider } from "./llm/groq-llm.provider";
import { LLM_PROVIDER_TOKEN } from "./llm/llm-provider";
import { RepositorySummaryService } from "./repository-summary.service";

@Module({
  imports: [ConfigModule, InternalModule, RetrievalModule, UsageModule],
  controllers: [ChatInternalController],
  providers: [
    { provide: LLM_PROVIDER_TOKEN, useClass: GroqLlmProvider },
    ChatConversationsRepository,
    ChatMessagesRepository,
    IndexerHttpClient,
    RepositorySummaryService,
    GraphSummaryService,
    CitationValidatorService,
    ChatService,
  ],
  exports: [ChatConversationsRepository],
})
export class ChatModule {}
