import type { Logger } from "@aca/logger";
import type { EmbeddingProvider, EmbeddingResult } from "./embedding-provider";

export interface EmbedInBatchesInput {
  provider: EmbeddingProvider;
  texts: string[];
  batchSize: number;
  concurrency: number;
  logger: Logger;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/**
 * Splits `texts` into `batchSize`-sized batches and embeds up to
 * `concurrency` batches at once, each retried with backoff on failure
 * (SEARCH_EMBEDDING_SERVICE_PLAN.md "Embedding provider adapter with
 * bounded concurrency and backoff"). Batch order is preserved in the
 * output regardless of completion order.
 */
export async function embedInBatches(input: EmbedInBatchesInput): Promise<EmbeddingResult[]> {
  const { provider, texts, batchSize, concurrency, logger } = input;
  if (texts.length === 0) return [];

  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const results: EmbeddingResult[][] = new Array(batches.length);
  let nextBatchIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const batchIndex = nextBatchIndex++;
      if (batchIndex >= batches.length) return;
      results[batchIndex] = await embedWithRetry(provider, batches[batchIndex]!, logger);
    }
  }

  const workerCount = Math.min(concurrency, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results.flat();
}

async function embedWithRetry(provider: EmbeddingProvider, batch: string[], logger: Logger, attempt = 1): Promise<EmbeddingResult[]> {
  try {
    return await provider.embedBatch(batch);
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) throw err;
    const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    logger.warn({ err, attempt, batchSize: batch.length }, "embedding batch failed, retrying with backoff");
    await sleep(delayMs);
    return embedWithRetry(provider, batch, logger, attempt + 1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
