import { describe, expect, it, vi } from "vitest";
import type { ChunkDto } from "@aca/contracts";
import type { Logger } from "@aca/logger";
import { CitationValidatorService, extractCitations } from "./citation-validator.service";
import type { IndexerHttpClient } from "./indexer-http.client";

const REPO_ID = "123e4567-e89b-12d3-a456-426614174000";

function chunk(overrides: Partial<ChunkDto> = {}): ChunkDto {
  return {
    chunkId: "chunk-1",
    path: "src/app.ts",
    startLine: 10,
    endLine: 20,
    symbolName: "bootstrap",
    symbolType: "function",
    language: "typescript",
    score: 1,
    content: "function bootstrap() {}",
    ...overrides,
  };
}

function buildService(opts: { findFileByExactPath: (repoId: string, path: string) => Promise<{ lineCount: number } | null> }) {
  const indexer = {
    findFileByExactPath: vi.fn(opts.findFileByExactPath),
  } as unknown as IndexerHttpClient;
  const logger = { warn: vi.fn() } as unknown as Logger;
  return { service: new CitationValidatorService(indexer, logger), indexer, logger };
}

describe("extractCitations", () => {
  it("extracts a well-formed citation", () => {
    expect(extractCitations("See [src/app.ts:10-20] for details.")).toEqual([{ path: "src/app.ts", startLine: 10, endLine: 20 }]);
  });

  it("extracts multiple citations", () => {
    expect(extractCitations("[a.ts:1-2] and [b.ts:5-9]")).toHaveLength(2);
  });

  it("ignores a citation with startLine > endLine", () => {
    expect(extractCitations("[a.ts:20-10]")).toEqual([]);
  });

  it("returns an empty array when there are no citations", () => {
    expect(extractCitations("No citations here.")).toEqual([]);
  });

  it("extracts a citation wrapped in fullwidth brackets — observed live from Groq's compound-mini despite the ASCII-bracket instruction", () => {
    expect(extractCitations("See 【src/app.ts:10-20】 for details.")).toEqual([{ path: "src/app.ts", startLine: 10, endLine: 20 }]);
  });
});

describe("CitationValidatorService", () => {
  it("keeps a citation whose range overlaps a prompted chunk", async () => {
    const { service } = buildService({ findFileByExactPath: async () => ({ lineCount: 100 }) });
    const result = await service.validate(REPO_ID, "See [src/app.ts:12-15] for details.", [chunk()]);
    expect(result).toEqual([{ path: "src/app.ts", startLine: 12, endLine: 15, symbolName: "bootstrap" }]);
  });

  it("strips a citation whose file does not exist in the active snapshot", async () => {
    const { service, logger } = buildService({ findFileByExactPath: async () => null });
    const result = await service.validate(REPO_ID, "See [ghost.ts:1-5].", [chunk({ path: "ghost.ts" })]);
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("strips a citation whose range exceeds the file's line count", async () => {
    const { service } = buildService({ findFileByExactPath: async () => ({ lineCount: 5 }) });
    const result = await service.validate(REPO_ID, "See [src/app.ts:1-10].", [chunk({ startLine: 1, endLine: 10 })]);
    expect(result).toEqual([]);
  });

  it("strips a citation that does not overlap any prompted chunk", async () => {
    const { service } = buildService({ findFileByExactPath: async () => ({ lineCount: 100 }) });
    const result = await service.validate(REPO_ID, "See [src/app.ts:50-55].", [chunk({ startLine: 10, endLine: 20 })]);
    expect(result).toEqual([]);
  });

  it("looks up each cited path only once even with multiple citations for it", async () => {
    const findFileByExactPath = vi.fn(async () => ({ lineCount: 100 }));
    const { service } = buildService({ findFileByExactPath });
    await service.validate(REPO_ID, "[src/app.ts:10-12] and [src/app.ts:15-18]", [chunk({ startLine: 1, endLine: 30 })]);
    expect(findFileByExactPath).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array without calling indexer when the answer has no citations", async () => {
    const { service, indexer } = buildService({ findFileByExactPath: async () => null });
    const result = await service.validate(REPO_ID, "No citations in this answer.", []);
    expect(result).toEqual([]);
    expect(indexer.findFileByExactPath).not.toHaveBeenCalled();
  });
});
