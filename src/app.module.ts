import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { InfraModule } from "./shared/infra.module";
import { HealthModule } from "./shared/health/health.module";
import { InternalModule } from "./internal/internal.module";

@Module({
  imports: [ConfigModule, InfraModule, HealthModule, InternalModule],
})
export class AppModule {}
