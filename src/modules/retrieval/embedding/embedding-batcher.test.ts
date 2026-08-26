import { describe, expect, it, vi } from "vitest";
import { embedInBatches } from "./embedding-batcher";
import type { EmbeddingProvider } from "./embedding-provider";

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function fakeProvider(embedBatch: EmbeddingProvider["embedBatch"]): EmbeddingProvider {
  return { model: "fake", dimensions: 4, embedBatch };
}

describe("embedInBatches", () => {
  it("returns an empty array without calling the provider for zero texts", async () => {
    const embedBatch = vi.fn();
    await embedInBatches({ provider: fakeProvider(embedBatch), texts: [], batchSize: 2, concurrency: 2, logger: fakeLogger() });
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it("splits into batches of the configured size and preserves overall order", async () => {
    const embedBatch = vi.fn(async (batch: string[]) => batch.map((t) => ({ embedding: [t.length], tokenCount: t.length })));
    const texts = ["a", "bb", "ccc", "dddd", "e"];

    const results = await embedInBatches({ provider: fakeProvider(embedBatch), texts, batchSize: 2, concurrency: 2, logger: fakeLogger() });

    expect(embedBatch).toHaveBeenCalledTimes(3); // [a,bb] [ccc,dddd] [e]
    expect(results.map((r) => r.tokenCount)).toEqual([1, 2, 3, 4, 1]);
  });

  it("never runs more than `concurrency` batches at once", async () => {
    let active = 0;
    let maxActive = 0;
    const embedBatch = vi.fn(async (batch: string[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return batch.map((t) => ({ embedding: [0], tokenCount: t.length }));
    });

    await embedInBatches({
      provider: fakeProvider(embedBatch),
      texts: ["a", "b", "c", "d", "e", "f"],
      batchSize: 1,
      concurrency: 2,
      logger: fakeLogger(),
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("retries a failing batch with backoff and succeeds", async () => {
    let calls = 0;
    const embedBatch = vi.fn(async (batch: string[]) => {
      calls += 1;
      if (calls < 2) throw new Error("transient failure");
      return batch.map((t) => ({ embedding: [0], tokenCount: t.length }));
    });

    const results = await embedInBatches({
      provider: fakeProvider(embedBatch),
      texts: ["a"],
      batchSize: 1,
      concurrency: 1,
      logger: fakeLogger(),
    });

    expect(calls).toBe(2);
    expect(results).toHaveLength(1);
  });

  it("throws after exhausting retries", async () => {
    const embedBatch = vi.fn(async () => {
      throw new Error("permanent failure");
    });

    await expect(
      embedInBatches({ provider: fakeProvider(embedBatch), texts: ["a"], batchSize: 1, concurrency: 1, logger: fakeLogger() })
    ).rejects.toThrow("permanent failure");
    expect(embedBatch).toHaveBeenCalledTimes(3);
  });
});
