import { Global, MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { CorrelationIdMiddleware } from "./correlation.middleware";
import { loggerConfig } from "./logger.config";
import { MetricsService } from "./metrics.service";
import { MetricsController } from "./metrics.controller";

/**
 * Observability module — provides:
 *   1. Per-request correlation-id middleware backed by AsyncLocalStorage.
 *   2. Structured JSON logger (nestjs-pino) that:
 *      - shares the same `X-Request-Id` header as the correlation
 *        middleware, so every log line carries the id;
 *      - emits one JSON line per request and per `Logger.log` call;
 *      - redacts authorization headers, cookies, and PII fields
 *        (passwords, tokens, encrypted secrets) before they reach the
 *        log pipeline.
 *
 * Registered once by `app.module.ts`. Wire Sentry (in `main.ts`) to
 * capture the same events — GlitchTip accepts the Sentry SDK DSN, so
 * the only cost is the network egress.
 */
@Global()
@Module({
  imports: [LoggerModule.forRoot(loggerConfig)],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes("*");
  }
}