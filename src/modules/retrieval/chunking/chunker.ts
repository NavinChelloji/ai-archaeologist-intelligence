import { chunkByLineWindow } from "./line-window-chunker";
import { chunkTsFile, isTsChunkable } from "./ts-symbol-chunker";
import type { ChunkFileInput, ChunkSpec } from "./chunk-types";

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
}

/**
 * Symbol-aware chunking for TS/JS, line-window fallback for everything else
 * (SEARCH_EMBEDDING_SERVICE_PLAN.md "Chunking Strategy" — "Other languages
 * still get ... chunking ... (line-window fallback)" per CODEBASE.md's
 * non-obvious invariants). Empty files produce zero chunks.
 */
export function chunkFile(input: ChunkFileInput, options: ChunkOptions): ChunkSpec[] {
  if (input.content.length === 0) return [];

  if (isTsChunkable(input.path)) {
    return chunkTsFile({ path: input.path, content: input.content }, options);
  }

  const lines = input.content.split("\n");
  return chunkByLineWindow({ lines, firstLineNumber: 1, maxTokens: options.maxTokens, overlapTokens: options.overlapTokens });
}
