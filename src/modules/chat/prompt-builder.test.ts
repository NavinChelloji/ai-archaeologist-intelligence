import { describe, expect, it } from "vitest";
import type { ChunkDto } from "@aca/contracts";
import { buildPrompt, NO_CONTEXT_INSTRUCTION, SYSTEM_PROMPT } from "./prompt-builder";

function chunk(overrides: Partial<ChunkDto> = {}): ChunkDto {
  return {
    chunkId: "chunk-1",
    path: "src/app.ts",
    startLine: 1,
    endLine: 10,
    symbolName: null,
    symbolType: null,
    language: "typescript",
    score: 1,
    content: "line".repeat(50),
    ...overrides,
  };
}

const BASE_INPUT = {
  repositorySummary: "REPOSITORY: acme/widgets",
  graphSummary: null,
  history: [],
  question: "What does bootstrap do?",
  maxHistoryMessages: 10,
};

describe("buildPrompt", () => {
  it("puts the system prompt first", () => {
    const result = buildPrompt({ ...BASE_INPUT, chunks: [], maxContextTokens: 10000 });
    expect(result.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  });

  it("uses the no-context instruction when there are no chunks", () => {
    const result = buildPrompt({ ...BASE_INPUT, chunks: [], maxContextTokens: 10000 });
    const lastMessage = result.messages.at(-1)!;
    expect(lastMessage.content).toContain(NO_CONTEXT_INSTRUCTION);
    expect(result.usedChunks).toEqual([]);
  });

  it("includes all chunks when the budget comfortably fits them", () => {
    const chunks = [chunk({ chunkId: "a" }), chunk({ chunkId: "b" }), chunk({ chunkId: "c" })];
    const result = buildPrompt({ ...BASE_INPUT, chunks, maxContextTokens: 10000 });
    expect(result.usedChunks.map((c) => c.chunkId)).toEqual(["a", "b", "c"]);
  });

  it("stops adding chunks once the token budget is exhausted, keeping only the best-ranked ones that fit", () => {
    // Each formatted chunk block is 224 chars -> exactly 56 estimated tokens; a 60-token budget fits
    // exactly one chunk (56 <= 60, 4 left over) and rejects the second (56 > 4).
    const chunks = [chunk({ chunkId: "best" }), chunk({ chunkId: "second" }), chunk({ chunkId: "third" })];
    const result = buildPrompt({ ...BASE_INPUT, chunks, maxContextTokens: 60 });
    expect(result.usedChunks.map((c) => c.chunkId)).toEqual(["best"]);
  });

  it("displays chunks best-ranked last, closest to the question", () => {
    const chunks = [chunk({ chunkId: "best", path: "best.ts" }), chunk({ chunkId: "second", path: "second.ts" })];
    const result = buildPrompt({ ...BASE_INPUT, chunks, maxContextTokens: 10000 });
    const contextMessage = result.messages.at(-1)!.content;
    expect(contextMessage.indexOf("second.ts")).toBeLessThan(contextMessage.indexOf("best.ts"));
    expect(contextMessage.indexOf("best.ts")).toBeLessThan(contextMessage.indexOf("Question:"));
  });

  it("truncates history to the last maxHistoryMessages, oldest dropped first", () => {
    const history = [
      { role: "user" as const, content: "q1" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "q2" },
      { role: "assistant" as const, content: "a2" },
    ];
    const result = buildPrompt({ ...BASE_INPUT, chunks: [], history, maxHistoryMessages: 2, maxContextTokens: 10000 });
    const historyInPrompt = result.messages.slice(1, -1);
    expect(historyInPrompt).toEqual([
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  it("places the question last in the final context message", () => {
    const result = buildPrompt({ ...BASE_INPUT, chunks: [], maxContextTokens: 10000 });
    const contextMessage = result.messages.at(-1)!.content;
    expect(contextMessage.trim().endsWith(`Question: ${BASE_INPUT.question}`)).toBe(true);
  });

  it("includes the graph summary when provided", () => {
    const result = buildPrompt({ ...BASE_INPUT, chunks: [], graphSummary: "STRUCTURE (top-level):\n  src", maxContextTokens: 10000 });
    expect(result.messages.at(-1)!.content).toContain("STRUCTURE (top-level):");
  });
});
