import { Global, Module } from "@nestjs/common";
import {
  createHttpMetrics,
  createMetricsRegistry,
  createProviderMetrics,
  type HttpMetrics,
  type ProviderMetrics,
  type Registry,
} from "@aca/metrics";
import { MetricsController } from "./metrics.controller";
import { HTTP_METRICS, METRICS_REGISTRY, PROVIDER_METRICS } from "./metrics.tokens";

export { HTTP_METRICS, METRICS_REGISTRY, PROVIDER_METRICS };

/**
 * `GET /metrics` and the metric objects every other module observes into
 * (RULES.md #15 "Metrics for HTTP latency ... embedding duration, chat
 * latency, and provider errors"). Global, like `InfraModule`.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: METRICS_REGISTRY, useFactory: (): Registry => createMetricsRegistry("ai") },
    { provide: HTTP_METRICS, inject: [METRICS_REGISTRY], useFactory: (r: Registry): HttpMetrics => createHttpMetrics(r) },
    { provide: PROVIDER_METRICS, inject: [METRICS_REGISTRY], useFactory: (r: Registry): ProviderMetrics => createProviderMetrics(r) },
  ],
  exports: [METRICS_REGISTRY, HTTP_METRICS, PROVIDER_METRICS],
})
export class MetricsModule {}
