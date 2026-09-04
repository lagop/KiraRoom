import { Module } from "@nestjs/common";
import { WidgetController, EmbedController } from "./widget.controller";
import { WidgetService } from "./widget.service";

@Module({
  controllers: [WidgetController, EmbedController],
  providers: [WidgetService],
  exports: [WidgetService],
})
export class WidgetModule {}