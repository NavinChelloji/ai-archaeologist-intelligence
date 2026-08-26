import { Inject, Injectable } from "@nestjs/common";
import type { ChunkDto, CitationDto } from "@aca/contracts";
import type { Logger } from "@aca/logger";
import { APP_LOGGER } from "../../shared/infra.module";
import { IndexerHttpClient } from "./indexer-http.client";

export interface ExtractedCitation {
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * `[path:startLine-endLine]`, e.g. `[src/app.ts:88-141]` (LLM_PROMPTING.md
 * "Citation Rules") — but also accepts fullwidth `【...】`, since Groq's
 * compound-mini reliably substitutes that bracket style in practice despite
 * the system prompt spelling out ASCII brackets. Widening extraction here is
 * a parsing-robustness fix, not a prompt change: SYSTEM_PROMPT stays exactly
 * as documented (LLM_PROMPTING.md's own versioned change process governs
 * that text, not this file), and a citation still has to pass the full
 * validate() pipeline below regardless of which bracket style produced it.
 */
const CITATION_RE = /[[【]([^\]】:[]+):(\d+)-(\d+)[\]】]/g;

export function extractCitations(text: string): ExtractedCitation[] {
  const results: ExtractedCitation[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const path = match[1];
    const startLine = Number(match[2]);
    const endLine = Number(match[3]);
    if (!path || !Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || startLine > endLine) continue;
    results.push({ path, startLine, endLine });
  }
  return results;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Validates every citation the model emitted against `indexer` before a
 * message is stored (CHAT_SERVICE_PLAN.md "Citation Validation — required").
 * Three checks, all must pass: the path exists in the active snapshot, the
 * range is within the file's line count, and the range overlaps a chunk
 * that was actually in the prompt (not just anywhere in the file) — that
 * last check is what stops the model from citing real coordinates for a
 * claim it never actually saw. Failing citations are stripped and logged,
 * never surfaced to the user as an error.
 */
@Injectable()
export class CitationValidatorService {
  constructor(
    private readonly indexer: IndexerHttpClient,
    @Inject(APP_LOGGER) private readonly logger: Logger
  ) {}

  async validate(repoId: string, modelOutput: string, promptedChunks: ChunkDto[]): Promise<CitationDto[]> {
    const extracted = extractCitations(modelOutput);
    if (extracted.length === 0) return [];

    const byPath = new Map<string, ExtractedCitation[]>();
    for (const citation of extracted) {
      const list = byPath.get(citation.path) ?? [];
      list.push(citation);
      byPath.set(citation.path, list);
    }

    const valid: CitationDto[] = [];
    for (const [path, citations] of byPath) {
      const file = await this.indexer.findFileByExactPath(repoId, path).catch(() => null);
      if (!file) {
        this.logger.warn({ repoId, path }, "stripped citation: file not found in active snapshot");
        continue;
      }

      for (const citation of citations) {
        if (citation.endLine > file.lineCount) {
          this.logger.warn({ repoId, citation }, "stripped citation: line range exceeds file length");
          continue;
        }

        const overlappingChunk = promptedChunks.find(
          (chunk) => chunk.path === path && rangesOverlap(citation.startLine, citation.endLine, chunk.startLine, chunk.endLine)
        );
        if (!overlappingChunk) {
          this.logger.warn({ repoId, citation }, "stripped citation: does not overlap a chunk that was in the prompt");
          continue;
        }

        valid.push({
          path,
          startLine: citation.startLine,
          endLine: citation.endLine,
          symbolName: overlappingChunk.symbolName,
        });
      }
    }

    return valid;
  }
}
