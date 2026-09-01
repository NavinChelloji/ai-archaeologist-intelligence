import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ConfigModule } from "./config/config.module";
import { InfraModule } from "./shared/infra.module";
import { HealthModule } from "./shared/health/health.module";
import { MetricsModule } from "./shared/metrics/metrics.module";
import { AllExceptionsFilter } from "./shared/errors/all-exceptions.filter";
import { InternalModule } from "./internal/internal.module";
import { RetrievalModule } from "./modules/retrieval/retrieval.module";
import { ChatModule } from "./modules/chat/chat.module";
import { DeletionModule } from "./modules/deletion/deletion.module";

@Module({
  imports: [
    ConfigModule,
    InfraModule,
    HealthModule,
    MetricsModule,
    InternalModule,
    RetrievalModule,
    ChatModule,
    DeletionModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
