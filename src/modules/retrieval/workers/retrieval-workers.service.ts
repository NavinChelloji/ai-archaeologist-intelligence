import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { DEFAULT_RETRY_POLICY, ensureProductQueue, subscribeJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_LOGGER, PG_BOSS, PG_POOL } from "../../../shared/infra.module";
import { IndexingService } from "../indexing.service";

const CONSUMER = "ai.retrieval";

/**
 * Registers this module's queue subscription (SEARCH_EMBEDDING_SERVICE_PLAN.md
 * "Jobs: Consumed"). `repo.index.requested` has a single consumer (this
 * one), so no fan-out queue name is needed — see `FANOUT_QUEUES` in
 * `@aca/queue`. `repo.embeddings.completed` and `repo.stage.failed` are
 * published here but their queues are already `ensureProductQueue`'d by
 * the indexer's PipelineWorkersService (which also consumes both) —
 * re-declared here anyway for resilience to startup ordering, matching the
 * indexer's own GraphWorkersService precedent. Runs in both the HTTP and
 * `--role=worker` processes.
 */
@Injectable()
export class RetrievalWorkersService implements OnApplicationBootstrap {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly indexing: IndexingService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await ensureProductQueue(this.boss, "repo.index.requested", DEFAULT_RETRY_POLICY);
    await ensureProductQueue(this.boss, "repo.embeddings.completed", DEFAULT_RETRY_POLICY);
    await ensureProductQueue(this.boss, "repo.stage.failed", DEFAULT_RETRY_POLICY);

    await subscribeJob(
      this.boss,
      "repo.index.requested",
      { consumer: `${CONSUMER}.index_requested`, pool: this.pool, logger: this.logger },
      (envelope) => this.indexing.handleIndexRequested(envelope)
    );
  }
}
