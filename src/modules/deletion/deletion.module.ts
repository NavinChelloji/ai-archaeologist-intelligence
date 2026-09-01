import { Module } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { InternalModule } from "../../internal/internal.module";
import { ChatModule } from "../chat/chat.module";
import { RetrievalModule } from "../retrieval/retrieval.module";
import { UsageModule } from "../usage/usage.module";
import { DeletionIndexerClient } from "./deletion-indexer.client";
import { DeletionService } from "./deletion.service";
import { SnapshotPruneService } from "./snapshot-prune.service";
import { DeletionWorkersService } from "./workers/deletion-workers.service";

/**
 * Cross-cutting cleanup for `repo.deleted`, `user.deleted`, and
 * `snapshot.prune` (DATA_RETENTION_AND_PRIVACY.md "Deletion"). Imports
 * ChatModule/RetrievalModule/UsageModule for the repositories it cleans up
 * rather than owning any table itself.
 */
@Module({
  imports: [ConfigModule, InternalModule, ChatModule, RetrievalModule, UsageModule],
  providers: [DeletionIndexerClient, DeletionService, SnapshotPruneService, DeletionWorkersService],
})
export class DeletionModule {}
