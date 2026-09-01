import { Inject, Injectable } from "@nestjs/common";
import type { TypedEnvelope } from "@aca/contracts";
import type { Logger } from "@aca/logger";
import { APP_LOGGER } from "../../shared/infra.module";
import { CodeChunksRepository } from "../retrieval/code-chunks.repository";
import { SnapshotChunksRepository } from "../retrieval/snapshot-chunks.repository";
import { DeletionIndexerClient } from "./deletion-indexer.client";

/**
 * `ai`'s half of `snapshot.prune` (DATA_RETENTION_AND_PRIVACY.md "Chunks are
 * keyed on (repo_id, content_hash) and referenced by snapshot_chunks, so
 * pruning a snapshot deletes only the chunks no remaining snapshot still
 * references"). `ai` has no snapshot table of its own, so it asks `indexer`
 * which snapshot ids are still retained rather than trying to recompute
 * `retainCount` itself — eventually consistent with indexer's own prune
 * (whichever handler runs first, the other simply has less or nothing to do,
 * and self-corrects on the next scheduled prune).
 */
@Injectable()
export class SnapshotPruneService {
  constructor(
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly indexer: DeletionIndexerClient,
    private readonly snapshotChunks: SnapshotChunksRepository,
    private readonly codeChunks: CodeChunksRepository
  ) {}

  async handleSnapshotPrune(envelope: TypedEnvelope<"snapshot.prune">): Promise<void> {
    const { repoId } = envelope.payload;
    const retainedSnapshotIds = await this.indexer.getRetainedSnapshotIds(repoId);

    const removedLinks = await this.snapshotChunks.deleteForRepoNotIn(repoId, retainedSnapshotIds);
    const removedChunks = await this.codeChunks.deleteOrphaned(repoId);

    this.logger.info({ repoId, removedLinks, removedChunks }, "ai snapshot prune completed");
  }
}
