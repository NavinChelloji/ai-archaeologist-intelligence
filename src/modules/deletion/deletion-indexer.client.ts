import { Inject, Injectable } from "@nestjs/common";
import { AppError, type InternalRepositorySnapshotsResponse } from "@aca/contracts";
import { APP_CONFIG } from "../../config/config.module";
import type { AiEnv } from "../../config/env";
import { InternalTokenService } from "../../internal/internal-token.service";

const USER_AGENT = "ai-code-archaeologist";

/**
 * `ai`'s own minimal client for `indexer`'s new snapshot-retention endpoint
 * (EVENT_CONTRACTS.md `snapshot.prune`). `ai` has no `repository_snapshots`
 * table of its own, so this is the only source of truth for "which snapshot
 * ids are still valid" after indexer prunes. Deliberately separate from
 * `modules/chat/indexer-http.client.ts` — that client belongs to the Chat
 * module; this one belongs to Deletion, matching how `api` and `ai` already
 * each keep their own indexer client rather than sharing one.
 */
@Injectable()
export class DeletionIndexerClient {
  constructor(
    private readonly internalTokens: InternalTokenService,
    @Inject(APP_CONFIG) private readonly config: AiEnv
  ) {}

  async getRetainedSnapshotIds(repoId: string): Promise<string[]> {
    const token = this.internalTokens.issue({ iss: "ai", aud: "indexer", sub: "ai", repoId, scope: ["repo:read"] });

    let response: Response;
    try {
      response = await fetch(`${this.config.INDEXER_SERVICE_URL}/internal/repositories/${repoId}/snapshots`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
      });
    } catch {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Could not reach the indexing service.");
    }

    if (!response.ok) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "The indexing service could not list retained snapshots.");
    }

    const body = (await response.json()) as InternalRepositorySnapshotsResponse;
    return body.snapshotIds;
  }
}
