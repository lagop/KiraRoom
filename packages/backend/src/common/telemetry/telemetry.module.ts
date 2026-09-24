import { Global, Module } from "@nestjs/common";
import { ProductEventsService } from "./product-events.service";

/** Global so any module can record an event without wiring imports. */
@Global()
@Module({
  providers: [ProductEventsService],
  exports: [ProductEventsService],
})
export class TelemetryModule {}
