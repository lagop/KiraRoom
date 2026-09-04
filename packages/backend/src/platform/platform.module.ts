import { Module } from "@nestjs/common";
import { PlatformLlmConfigController } from "./platform-llm-config.controller";
import { PlatformLlmConfigService } from "./platform-llm-config.service";
import { CommonModule } from "../common/common.module";

@Module({
  imports: [CommonModule],
  controllers: [PlatformLlmConfigController],
  providers: [PlatformLlmConfigService],
  exports: [PlatformLlmConfigService],
})
export class PlatformModule {}