import { estimateTokens } from "./token-estimate";
import type { ChunkSpec } from "./chunk-types";

const CHARS_PER_TOKEN = 4;

export interface LineWindowInput {
  /** Lines to chunk — already sliced to whatever range the caller wants covered. */
  lines: string[];
  /** 1-indexed line number of `lines[0]` in the source file. */
  firstLineNumber: number;
  maxTokens: number;
  overlapTokens: number;
}

/**
 * Fixed-size sliding window over lines, used both as the whole-file fallback
 * for languages without symbol-aware chunking and to sweep up any file
 * regions the symbol chunker didn't cover (leading imports, gaps between
 * declarations) — SEARCH_EMBEDDING_SERVICE_PLAN.md "Chunking Strategy" step
 * 4. Every chunk stays under `maxTokens`; consecutive chunks overlap by
 * roughly `overlapTokens` so a boundary never silently splits the answer to
 * a likely question in half.
 */
export function chunkByLineWindow(input: LineWindowInput): ChunkSpec[] {
  const { lines, firstLineNumber, maxTokens, overlapTokens } = input;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  const chunks: ChunkSpec[] = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length) {
      const lineChars = lines[end]!.length + 1;
      if (end > start && chars + lineChars > maxChars) break;
      chars += lineChars;
      end += 1;
    }
    // A single line longer than the whole budget still makes progress — never loops forever.
    if (end === start) end = start + 1;

    const content = lines.slice(start, end).join("\n");
    chunks.push({
      startLine: firstLineNumber + start,
      endLine: firstLineNumber + end - 1,
      symbolName: null,
      symbolType: null,
      content,
      estimatedTokens: estimateTokens(content),
    });

    if (end >= lines.length) break;

    // Step the next window back by ~overlapTokens so context isn't lost at the seam,
    // but always advance past the current start so the loop makes progress.
    let back = end;
    let overlapAccum = 0;
    while (back > start && overlapAccum < overlapChars) {
      back -= 1;
      overlapAccum += lines[back]!.length + 1;
    }
    start = Math.max(back, start + 1);
  }

  return chunks;
}
