import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiEnv } from "../../../config/env";

const pipelineMock = vi.hoisted(() => vi.fn());
const fromPretrainedMock = vi.hoisted(() => vi.fn());

vi.mock("@xenova/transformers", () => ({
  pipeline: pipelineMock,
  AutoTokenizer: { from_pretrained: fromPretrainedMock },
}));

afterEach(() => {
  vi.clearAllMocks();
});

async function importProvider() {
  const { TransformersEmbeddingProvider } = await import("./transformers-embedding.provider");
  return TransformersEmbeddingProvider;
}

function config(): AiEnv {
  return { EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2" } as AiEnv;
}

describe("TransformersEmbeddingProvider", () => {
  it("returns an empty array without loading the model for zero texts", async () => {
    const TransformersEmbeddingProvider = await importProvider();
    const provider = new TransformersEmbeddingProvider(config());

    const results = await provider.embedBatch([]);

    expect(results).toEqual([]);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("embeds with mean pooling + normalization and reports the tokenizer's real token count", async () => {
    const extractor = vi.fn(async (texts: string[]) => ({
      tolist: () => texts.map((_, i) => [i, i, i]),
    }));
    pipelineMock.mockResolvedValue(extractor);

    const tokenizer = vi.fn((text: string) => ({ input_ids: { size: text.length } }));
    fromPretrainedMock.mockResolvedValue(tokenizer);

    const TransformersEmbeddingProvider = await importProvider();
    const provider = new TransformersEmbeddingProvider(config());

    const results = await provider.embedBatch(["ab", "xyz"]);

    expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    expect(extractor).toHaveBeenCalledWith(["ab", "xyz"], { pooling: "mean", normalize: true });
    expect(results).toEqual([
      { embedding: [0, 0, 0], tokenCount: 2 },
      { embedding: [1, 1, 1], tokenCount: 3 },
    ]);
  });

  it("loads the pipeline and tokenizer only once across multiple calls", async () => {
    const extractor = vi.fn(async (texts: string[]) => ({ tolist: () => texts.map(() => [0]) }));
    pipelineMock.mockResolvedValue(extractor);
    const tokenizer = vi.fn(() => ({ input_ids: { size: 1 } }));
    fromPretrainedMock.mockResolvedValue(tokenizer);

    const TransformersEmbeddingProvider = await importProvider();
    const provider = new TransformersEmbeddingProvider(config());

    await provider.embedBatch(["a"]);
    await provider.embedBatch(["b"]);

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
  });

  it("exposes the configured model name and the pinned dimensionality", async () => {
    const TransformersEmbeddingProvider = await importProvider();
    const provider = new TransformersEmbeddingProvider(config());

    expect(provider.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(provider.dimensions).toBe(384);
  });
});
