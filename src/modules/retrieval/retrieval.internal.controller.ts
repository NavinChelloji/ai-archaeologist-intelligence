import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import {
  ChunkByIdResponseSchema,
  RetrieveRequestSchema,
  SearchRequestSchema,
  type ChunkByIdResponse,
  type RetrieveRequest,
  type RetrieveResponse,
  type SearchRequest,
  type SearchResponse,
} from "@aca/contracts";
import { InternalAuthGuard } from "../../internal/internal-auth.guard";
import { ZodValidationPipe } from "../../shared/validation/zod-validation.pipe";
import { RetrievalReadService } from "./retrieval-read.service";

/**
 * `/internal/*` — never routed from the public ingress, always behind
 * InternalAuthGuard (RULES.md #12). `api` is the only caller
 * (SEARCH_EMBEDDING_SERVICE_PLAN.md "APIs").
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class RetrievalInternalController {
  constructor(private readonly retrievalRead: RetrievalReadService) {}

  @Post("repositories/:repoId/retrieve")
  async retrieve(
    @Param("repoId") repoId: string,
    @Body(new ZodValidationPipe(RetrieveRequestSchema)) body: RetrieveRequest
  ): Promise<RetrieveResponse> {
    return this.retrievalRead.retrieve(repoId, body);
  }

  @Post("repositories/:repoId/search")
  async search(@Param("repoId") repoId: string, @Body(new ZodValidationPipe(SearchRequestSchema)) body: SearchRequest): Promise<SearchResponse> {
    return this.retrievalRead.search(repoId, body);
  }

  @Get("repositories/:repoId/chunks/:chunkId")
  async getChunk(@Param("chunkId") chunkId: string): Promise<ChunkByIdResponse> {
    const chunk = await this.retrievalRead.getChunkById(chunkId);
    return ChunkByIdResponseSchema.parse(chunk);
  }
}
