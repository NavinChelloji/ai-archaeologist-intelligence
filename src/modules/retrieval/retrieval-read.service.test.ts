import { describe, expect, it, vi } from "vitest";
import { AppError } from "@aca/contracts";
import type { AiEnv } from "../../config/env";
import type { CodeChunkRow, ScoredChunkRow } from "./code-chunks.repository";
import type { EmbeddingRunRow } from "./embedding-runs.repository";
import { RetrievalReadService } from "./retrieval-read.service";

const REPO_ID = "123e4567-e89b-12d3-a456-426614174000";
const SNAPSHOT_ID = "123e4567-e89b-12d3-a456-426614174010";

function chunkRow(overrides: Partial<CodeChunkRow> = {}): CodeChunkRow {
  return {
    id: "chunk-1",
    repo_id: REPO_ID,
    content_hash: "sha256:x",
    path: "src/a.ts",
    start_line: 1,
    end_line: 5,
    language: "typescript",
    symbol_name: "foo",
    symbol_type: "function",
    token_count: 10,
    content: "function foo() {}",
    embedding_model: "fake",
    embedding_version: 1,
    created_at: new Date(),
    ...overrides,
  };
}

function config(): AiEnv {
  return { RETRIEVAL_TOP_K: 40, RETRIEVAL_FINAL_K: 3, RETRIEVAL_MIN_SCORE: 0.25 } as AiEnv;
}

function buildService(opts: {
  latestRun?: EmbeddingRunRow | null;
  vectorResults?: ScoredChunkRow[];
  lexicalResults?: CodeChunkRow[];
  findByIdResult?: CodeChunkRow | null;
}) {
  const embeddingProvider = { model: "fake", dimensions: 4, embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 0, 0, 0], tokenCount: 1 }))) };
  const codeChunks = {
    findSimilarForSnapshot: vi.fn(async () => opts.vectorResults ?? []),
    findLexicalForSnapshot: vi.fn(async () => opts.lexicalResults ?? []),
    findById: vi.fn(async () => opts.findByIdResult ?? null),
    findExistingByContentHashes: vi.fn(),
    insertBatch: vi.fn(),
  };
  const embeddingRuns = {
    findLatestCompletedByRepoId: vi.fn(async () => (opts.latestRun === undefined ? { snapshot_id: SNAPSHOT_ID } as EmbeddingRunRow : opts.latestRun)),
    upsertRunning: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    findBySnapshotId: vi.fn(),
  };

  const service = new RetrievalReadService(config(), embeddingProvider, codeChunks as never, embeddingRuns as never);
  return { service, embeddingProvider, codeChunks, embeddingRuns };
}

describe("RetrievalReadService.retrieve", () => {
  it("returns an empty result with a null snapshotId when the repo has never finished indexing", async () => {
    const { service, embeddingProvider } = buildService({ latestRun: null });

    const result = await service.retrieve(REPO_ID, { query: "how does auth work" });

    expect(result).toEqual({ chunks: [], totalCandidates: 0, snapshotId: null });
    expect(embeddingProvider.embedBatch).not.toHaveBeenCalled();
  });

  it("merges vector and lexical candidates, boosting a lexical-only match to the max score", async () => {
    const vectorOnly = chunkRow({ id: "v1", path: "src/vec.ts" });
    const lexicalOnly = chunkRow({ id: "l1", path: "src/lex.ts", symbol_name: "AuthGuard" });

    const { service } = buildService({
      vectorResults: [{ ...vectorOnly, score: 0.4 }],
      lexicalResults: [lexicalOnly],
    });

    const result = await service.retrieve(REPO_ID, { query: "AuthGuard" });

    const ids = result.chunks.map((c) => c.chunkId);
    expect(ids).toContain("v1");
    expect(ids).toContain("l1");
    expect(result.chunks.find((c) => c.chunkId === "l1")?.score).toBe(1);
  });

  it("drops candidates scoring below RETRIEVAL_MIN_SCORE instead of padding results", async () => {
    const belowThreshold = chunkRow({ id: "low", path: "src/low.ts" });
    const { service } = buildService({ vectorResults: [{ ...belowThreshold, score: 0.1 }] });

    const result = await service.retrieve(REPO_ID, { query: "irrelevant question" });

    expect(result.chunks).toHaveLength(0);
    expect(result.totalCandidates).toBe(1); // still counted as a candidate, just filtered from the final list
  });

  it("diversifies across files instead of letting one file fill every slot", async () => {
    const fileACandidates = [0.9, 0.8, 0.7].map((score, i) => ({ ...chunkRow({ id: `a${i}`, path: "src/a.ts" }), score }));
    const fileBCandidate = { ...chunkRow({ id: "b0", path: "src/b.ts" }), score: 0.6 };

    const { service } = buildService({ vectorResults: [...fileACandidates, fileBCandidate] });

    const result = await service.retrieve(REPO_ID, { query: "q" }); // RETRIEVAL_FINAL_K = 3

    const paths = result.chunks.map((c) => c.path);
    expect(paths).toContain("src/b.ts"); // b's single candidate must appear before a's second/third
    expect(paths.filter((p) => p === "src/a.ts").length).toBeLessThan(3);
  });

  it("passes path/language/symbolType filters through to both the vector and lexical queries", async () => {
    const { service, codeChunks } = buildService({});
    const filters = { pathPrefix: "src/auth", language: "typescript", symbolType: "class" as const };

    await service.retrieve(REPO_ID, { query: "q", filters });

    expect(codeChunks.findSimilarForSnapshot).toHaveBeenCalledWith(expect.objectContaining({ filters }));
    expect(codeChunks.findLexicalForSnapshot).toHaveBeenCalledWith(expect.objectContaining({ filters }));
  });
});

describe("RetrievalReadService.search", () => {
  it("never calls the embedding provider — lexical only", async () => {
    const { service, embeddingProvider, codeChunks } = buildService({ lexicalResults: [chunkRow()] });

    const result = await service.search(REPO_ID, { q: "AuthGuard" });

    expect(embeddingProvider.embedBatch).not.toHaveBeenCalled();
    expect(codeChunks.findLexicalForSnapshot).toHaveBeenCalled();
    expect(result.chunks).toHaveLength(1);
  });

  it("returns an empty result when the repo has never finished indexing", async () => {
    const { service } = buildService({ latestRun: null });
    const result = await service.search(REPO_ID, { q: "anything" });
    expect(result).toEqual({ chunks: [], totalCandidates: 0, snapshotId: null });
  });
});

describe("RetrievalReadService.getChunkById", () => {
  it("returns the chunk when found", async () => {
    const { service } = buildService({ findByIdResult: chunkRow({ id: "found" }) });
    const chunk = await service.getChunkById("found");
    expect(chunk.chunkId).toBe("found");
  });

  it("throws NOT_FOUND when the chunk doesn't exist", async () => {
    const { service } = buildService({ findByIdResult: null });
    await expect(service.getChunkById("missing")).rejects.toThrow(AppError);
  });
});
