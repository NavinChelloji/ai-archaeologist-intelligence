import { Module } from "@nestjs/common";
import { TokenUsageRepository } from "./token-usage.repository";

/** Owns `token_usage`, the one table shared by the Chat and Retrieval modules for cost/quota tracking (RULES.md #2 — reached only through this module's export, never imported cross-module directly). */
@Module({
  providers: [TokenUsageRepository],
  exports: [TokenUsageRepository],
})
export class UsageModule {}
