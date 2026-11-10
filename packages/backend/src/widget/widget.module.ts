import { Module } from "@nestjs/common";
import { WidgetController, EmbedController } from "./widget.controller";
import { WidgetService } from "./widget.service";
import { PlatformModule } from "../platform/platform.module";

@Module({
  // PlatformModule: whether the salon can take online payments.
  imports: [PlatformModule],
  controllers: [WidgetController, EmbedController],
  providers: [WidgetService],
  exports: [WidgetService],
})
export class WidgetModule {}