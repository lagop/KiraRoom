import { Global, Module } from "@nestjs/common";
import { ProductEventsService } from "./product-events.service";
import { LlmUsageService } from "./llm-usage.service";

/** Global so any module can record an event without wiring imports. */
@Global()
@Module({
  providers: [ProductEventsService, LlmUsageService],
  exports: [ProductEventsService, LlmUsageService],
})
export class TelemetryModule {}
