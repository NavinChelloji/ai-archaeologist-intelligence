export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

/**
 * Provider-agnostic boundary (SEARCH_EMBEDDING_SERVICE_PLAN.md "Embedding
 * provider adapter"). `TransformersEmbeddingProvider` (local, free,
 * 384-dim) is the only implementation today; `IndexingService` depends on
 * this interface, not the concrete class, so it's testable with a fake and
 * swappable for a hosted provider later without touching callers.
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

export const EMBEDDING_PROVIDER = Symbol("EMBEDDING_PROVIDER");
