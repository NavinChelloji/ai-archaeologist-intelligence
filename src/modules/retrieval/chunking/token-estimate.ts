const CHARS_PER_TOKEN = 4;

/**
 * Cheap, model-agnostic estimate used only to decide chunk boundaries
 * (split oversized, skip trivially small) — not what's stored. The real
 * count stored in `code_chunks.token_count` / `embedding_runs.prompt_tokens`
 * comes from the embedding provider's own tokenizer, computed once per
 * chunk at embedding time.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
