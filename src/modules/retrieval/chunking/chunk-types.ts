import type { SymbolType } from "@aca/contracts";

/**
 * A chunker's pure output — no ids, no repo/snapshot context, no embedding.
 * The orchestrating service resolves those once it decides which chunks
 * are actually new (SEARCH_EMBEDDING_SERVICE_PLAN.md "Chunking Strategy").
 */
export interface ChunkSpec {
  /** 1-indexed, inclusive. */
  startLine: number;
  /** 1-indexed, inclusive. */
  endLine: number;
  symbolName: string | null;
  symbolType: SymbolType | null;
  content: string;
  /** Estimated at chunk-boundary time (token-estimate.ts) — the real count used for storage/telemetry comes from the embedding provider's own tokenizer. */
  estimatedTokens: number;
}

export interface ChunkFileInput {
  path: string;
  language: string | null;
  content: string;
}
