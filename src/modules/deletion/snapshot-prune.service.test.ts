import { describe, expect, it, vi } from "vitest";
import type { TypedEnvelope } from "@aca/contracts";
import { SnapshotPruneService } from "./snapshot-prune.service";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function envelope(repoId: string): TypedEnvelope<"snapshot.prune"> {
  return {
    eventId: "11111111-1111-1111-1111-111111111111",
    eventType: "snapshot.prune",
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: "22222222-2222-2222-2222-222222222222",
    causationId: null,
    userId: "00000000-0000-0000-0000-000000000000",
    repoId,
    snapshotId: null,
    retryCount: 0,
    payload: { repoId, retainCount: 2 },
  };
}

describe("SnapshotPruneService", () => {
  it("removes snapshot_chunks links for snapshots indexer no longer retains, then orphaned chunks", async () => {
    const indexer = { getRetainedSnapshotIds: vi.fn().mockResolvedValue(["s-4", "s-3"]) };
    const snapshotChunks = { deleteForRepoNotIn: vi.fn().mockResolvedValue(3) };
    const codeChunks = { deleteOrphaned: vi.fn().mockResolvedValue(1) };

    const prune = new SnapshotPruneService(noopLogger as never, indexer as never, snapshotChunks as never, codeChunks as never);
    await prune.handleSnapshotPrune(envelope("repo-1"));

    expect(indexer.getRetainedSnapshotIds).toHaveBeenCalledWith("repo-1");
    expect(snapshotChunks.deleteForRepoNotIn).toHaveBeenCalledWith("repo-1", ["s-4", "s-3"]);
    expect(codeChunks.deleteOrphaned).toHaveBeenCalledWith("repo-1");
  });

  it("is idempotent — nothing left to remove on a repeat delivery is not an error", async () => {
    const indexer = { getRetainedSnapshotIds: vi.fn().mockResolvedValue(["s-1"]) };
    const snapshotChunks = { deleteForRepoNotIn: vi.fn().mockResolvedValue(0) };
    const codeChunks = { deleteOrphaned: vi.fn().mockResolvedValue(0) };

    const prune = new SnapshotPruneService(noopLogger as never, indexer as never, snapshotChunks as never, codeChunks as never);
    await expect(prune.handleSnapshotPrune(envelope("repo-1"))).resolves.toBeUndefined();
  });
});
