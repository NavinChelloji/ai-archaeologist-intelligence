import { describe, expect, it, vi } from "vitest";
import { DeletionService } from "./deletion.service";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("DeletionService", () => {
  it("deletes conversations, embedding runs, and chunks for one repository", async () => {
    const conversations = { deleteByRepoId: vi.fn().mockResolvedValue(undefined) };
    const embeddingRuns = { deleteByRepoId: vi.fn().mockResolvedValue(undefined) };
    const codeChunks = { deleteByRepoId: vi.fn().mockResolvedValue(undefined) };
    const tokenUsage = { anonymizeUser: vi.fn() };

    const deletion = new DeletionService(
      noopLogger as never,
      conversations as never,
      embeddingRuns as never,
      codeChunks as never,
      tokenUsage as never
    );
    await deletion.deleteRepositoryData("repo-1");

    expect(conversations.deleteByRepoId).toHaveBeenCalledWith("repo-1");
    expect(embeddingRuns.deleteByRepoId).toHaveBeenCalledWith("repo-1");
    expect(codeChunks.deleteByRepoId).toHaveBeenCalledWith("repo-1");
  });

  it("is idempotent — a second call against an already-gone repo does not throw", async () => {
    const noop = { deleteByRepoId: vi.fn().mockResolvedValue(undefined) };
    const deletion = new DeletionService(noopLogger as never, noop as never, noop as never, noop as never, {
      anonymizeUser: vi.fn(),
    } as never);

    await deletion.deleteRepositoryData("repo-1");
    await expect(deletion.deleteRepositoryData("repo-1")).resolves.toBeUndefined();
  });

  it("deletes every repo's data and anonymizes the user's token usage on account deletion", async () => {
    const deleteByRepoId = vi.fn().mockResolvedValue(undefined);
    const noop = { deleteByRepoId };
    const anonymizeUser = vi.fn().mockResolvedValue(undefined);

    const deletion = new DeletionService(noopLogger as never, noop as never, noop as never, noop as never, { anonymizeUser } as never);
    await deletion.deleteForUser("user-1", ["repo-1", "repo-2"]);

    // `noop` stands in for all three repositories (conversations, embedding runs, code chunks),
    // each called once per repoId — 3 repositories x 2 repoIds.
    expect(deleteByRepoId).toHaveBeenCalledTimes(6);
    expect(deleteByRepoId.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["repo-1", "repo-1", "repo-1", "repo-2", "repo-2", "repo-2"])
    );
    expect(anonymizeUser).toHaveBeenCalledWith("user-1", "00000000-0000-0000-0000-000000000000");
  });
});
