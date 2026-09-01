import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { DEFAULT_RETRY_POLICY, ensureProductQueue, subscribeJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_LOGGER, PG_BOSS, PG_POOL } from "../../../shared/infra.module";
import { DeletionService } from "../deletion.service";
import { SnapshotPruneService } from "../snapshot-prune.service";

const CONSUMER = "ai.deletion";

/** `ai`'s fan-out queue names for the three deletion/retention events it shares with `indexer` — see `FANOUT_QUEUES` in `@aca/queue`. */
const REPO_DELETED_QUEUE = "repo.deleted.ai";
const USER_DELETED_QUEUE = "user.deleted.ai";
const SNAPSHOT_PRUNE_QUEUE = "snapshot.prune.ai";

/**
 * Registers `ai`'s queue subscriptions for `repo.deleted`, `user.deleted`,
 * and `snapshot.prune` (DATA_RETENTION_AND_PRIVACY.md "Deletion" and
 * "Retention"). `indexer` independently consumes the same three events on
 * its own, default-named queues. Runs in both the HTTP and `--role=worker`
 * processes, same as `RetrievalWorkersService`.
 */
@Injectable()
export class DeletionWorkersService implements OnApplicationBootstrap {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly deletion: DeletionService,
    private readonly prune: SnapshotPruneService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await ensureProductQueue(this.boss, "repo.deleted", DEFAULT_RETRY_POLICY, REPO_DELETED_QUEUE);
    await ensureProductQueue(this.boss, "user.deleted", DEFAULT_RETRY_POLICY, USER_DELETED_QUEUE);
    await ensureProductQueue(this.boss, "snapshot.prune", DEFAULT_RETRY_POLICY, SNAPSHOT_PRUNE_QUEUE);

    await subscribeJob(
      this.boss,
      "repo.deleted",
      { consumer: `${CONSUMER}.repo_deleted`, pool: this.pool, logger: this.logger },
      (envelope) => this.deletion.deleteRepositoryData(envelope.payload.repoId),
      REPO_DELETED_QUEUE
    );

    await subscribeJob(
      this.boss,
      "user.deleted",
      { consumer: `${CONSUMER}.user_deleted`, pool: this.pool, logger: this.logger },
      (envelope) => this.deletion.deleteForUser(envelope.payload.userId, envelope.payload.repoIds),
      USER_DELETED_QUEUE
    );

    await subscribeJob(
      this.boss,
      "snapshot.prune",
      { consumer: `${CONSUMER}.snapshot_prune`, pool: this.pool, logger: this.logger },
      (envelope) => this.prune.handleSnapshotPrune(envelope),
      SNAPSHOT_PRUNE_QUEUE
    );
  }
}
