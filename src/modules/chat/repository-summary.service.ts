import { Injectable } from "@nestjs/common";
import { IndexerHttpClient } from "./indexer-http.client";

/**
 * Builds the "Repository summary" context block (LLM_PROMPTING.md "Context
 * Assembly Order", ~300 tokens). Deliberately minimal: commit sha, file/
 * symbol counts, and entry-point detection from the plan's example are
 * omitted rather than built against new indexer endpoints — none of Stage
 * 9's exit criteria depend on those figures being present, and the fields
 * that ARE available (name, branch, primary language) are enough to ground
 * the model on which repository it's answering about.
 */
@Injectable()
export class RepositorySummaryService {
  constructor(private readonly indexer: IndexerHttpClient) {}

  async build(repoId: string): Promise<string> {
    const repository = await this.indexer.getRepository(repoId);

    return [
      `REPOSITORY: ${repository.fullName} (branch: ${repository.defaultBranch})`,
      `Primary language: ${repository.primaryLanguage ?? "unknown"}`,
      "Note: dependency and symbol graphs cover TypeScript/JavaScript only.",
    ].join("\n");
  }
}
