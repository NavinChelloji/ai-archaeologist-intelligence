import { Inject, Injectable } from "@nestjs/common";
import {
  AppError,
  ERROR_CODES,
  type ErrorCode,
  type GraphDependenciesQuery,
  type GraphFoldersQuery,
  type GraphNeighborsQuery,
  type GraphResponse,
  type GraphSearchQuery,
  type GraphSearchResponse,
  type RepositoryDto,
  type RepositoryFileDto,
} from "@aca/contracts";
import { APP_CONFIG } from "../../config/config.module";
import type { AiEnv } from "../../config/env";
import { InternalTokenService } from "../../internal/internal-token.service";

const USER_AGENT = "ai-code-archaeologist";
const KNOWN_CODES = new Set<string>(ERROR_CODES);

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && KNOWN_CODES.has(value);
}

function toQueryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * `ai`'s own typed client for `indexer`'s internal API — used for citation
 * validation and architecture/change graph summaries (CHAT_SERVICE_PLAN.md
 * "Citation Validation", "Question Classification"). Unlike `api`'s calls,
 * there is no per-request `userId` to resolve ownership for: `repoId` here
 * comes from a conversation the caller already owns (checked in `ai`'s own
 * `chat_conversations` table), so every token is minted with `sub: "ai"` — a
 * system identity, not a user one.
 */
@Injectable()
export class IndexerHttpClient {
  constructor(
    private readonly internalTokens: InternalTokenService,
    @Inject(APP_CONFIG) private readonly config: AiEnv
  ) {}

  getRepository(repoId: string): Promise<RepositoryDto> {
    return this.request("GET", `/internal/repositories/${repoId}`, repoId);
  }

  /** `path` filters by prefix server-side; this narrows to the one row whose path matches exactly, or null if none does. */
  async findFileByExactPath(repoId: string, path: string): Promise<RepositoryFileDto | null> {
    const params = toQueryString({ path, pageSize: 20 });
    const result = await this.request<{ files: RepositoryFileDto[]; nextCursor: string | null }>(
      "GET",
      `/internal/repositories/${repoId}/files${params}`,
      repoId
    );
    return result.files.find((f) => f.path === path) ?? null;
  }

  getFolders(repoId: string, query: GraphFoldersQuery): Promise<GraphResponse> {
    return this.request("GET", `/internal/repositories/${repoId}/graph/folders${toQueryString(query)}`, repoId);
  }

  getDependencies(repoId: string, query: GraphDependenciesQuery): Promise<GraphResponse> {
    return this.request("GET", `/internal/repositories/${repoId}/graph/dependencies${toQueryString(query)}`, repoId);
  }

  getNeighbors(repoId: string, nodeId: string, query: GraphNeighborsQuery): Promise<GraphResponse> {
    return this.request("GET", `/internal/repositories/${repoId}/graph/nodes/${nodeId}/neighbors${toQueryString(query)}`, repoId);
  }

  searchGraph(repoId: string, query: GraphSearchQuery): Promise<GraphSearchResponse> {
    return this.request("GET", `/internal/repositories/${repoId}/graph/search${toQueryString(query)}`, repoId);
  }

  private async request<T>(method: "GET" | "POST", path: string, repoId: string, body?: unknown): Promise<T> {
    const token = this.internalTokens.issue({ iss: "ai", aud: "indexer", sub: "ai", repoId, scope: ["repo:read"] });

    let response: Response;
    try {
      response = await fetch(`${this.config.INDEXER_SERVICE_URL}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": USER_AGENT,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Could not reach the indexing service.");
    }

    if (!response.ok) {
      const parsed = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const code = isErrorCode(parsed?.error?.code) ? parsed.error.code : "DEPENDENCY_UNAVAILABLE";
      throw new AppError(code, parsed?.error?.message ?? "The indexing service could not complete this request.");
    }

    return (await response.json()) as T;
  }
}
