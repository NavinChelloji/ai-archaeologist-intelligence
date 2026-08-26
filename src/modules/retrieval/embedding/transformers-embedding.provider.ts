import { Inject, Injectable } from "@nestjs/common";
import { AutoTokenizer, pipeline, type FeatureExtractionPipeline, type PreTrainedTokenizer, type Tensor } from "@xenova/transformers";
import { APP_CONFIG } from "../../../config/config.module";
import type { AiEnv } from "../../../config/env";
import type { EmbeddingProvider, EmbeddingResult } from "./embedding-provider";

/** Xenova/all-MiniLM-L6-v2's output width — pinned here, not in env, matching pgvector's DDL-time-fixed column width. */
export const TRANSFORMERS_EMBEDDING_DIMENSIONS = 384;

/**
 * Local, free embedding provider using Transformers.js — no API key, no
 * network call once the model is cached, no per-token cost. Model weights
 * download from the Hugging Face Hub on first use (~25-90MB) and are cached
 * on disk after that (see the `stage8-embedding-provider` project memory
 * for why this was chosen over OpenAI). The pipeline and tokenizer are
 * loaded once, lazily, and reused for the life of the process.
 */
@Injectable()
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = TRANSFORMERS_EMBEDDING_DIMENSIONS;

  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
  private tokenizerPromise: Promise<PreTrainedTokenizer> | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AiEnv) {}

  get model(): string {
    return this.config.EMBEDDING_MODEL;
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const [extractor, tokenizer] = await Promise.all([this.getPipeline(), this.getTokenizer()]);

    const output = (await extractor(texts, { pooling: "mean", normalize: true })) as Tensor;
    const vectors = output.tolist() as number[][];

    return texts.map((text, i) => {
      const encoded = tokenizer(text) as { input_ids: Tensor };
      return { embedding: vectors[i]!, tokenCount: encoded.input_ids.size };
    });
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= pipeline("feature-extraction", this.config.EMBEDDING_MODEL) as Promise<FeatureExtractionPipeline>;
    return this.pipelinePromise;
  }

  private async getTokenizer(): Promise<PreTrainedTokenizer> {
    this.tokenizerPromise ??= AutoTokenizer.from_pretrained(this.config.EMBEDDING_MODEL);
    return this.tokenizerPromise;
  }
}
