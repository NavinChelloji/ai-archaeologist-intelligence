import { Module } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { InternalModule } from "../../internal/internal.module";
import { CodeChunksRepository } from "./code-chunks.repository";
import { EmbeddingRunsRepository } from "./embedding-runs.repository";
import { EMBEDDING_PROVIDER } from "./embedding/embedding-provider";
import { TransformersEmbeddingProvider } from "./embedding/transformers-embedding.provider";
import { IndexingService } from "./indexing.service";
import { ManifestReaderService } from "./manifest-reader.service";
import { RetrievalReadService } from "./retrieval-read.service";
import { RetrievalInternalController } from "./retrieval.internal.controller";
import { SnapshotChunksRepository } from "./snapshot-chunks.repository";
import { RetrievalWorkersService } from "./workers/retrieval-workers.service";

@Module({
  imports: [ConfigModule, InternalModule],
  controllers: [RetrievalInternalController],
  providers: [
    { provide: EMBEDDING_PROVIDER, useClass: TransformersEmbeddingProvider },
    ManifestReaderService,
    CodeChunksRepository,
    SnapshotChunksRepository,
    EmbeddingRunsRepository,
    IndexingService,
    RetrievalReadService,
    RetrievalWorkersService,
  ],
  exports: [RetrievalReadService],
})
export class RetrievalModule {}
