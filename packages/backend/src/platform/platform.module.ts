import { Module } from "@nestjs/common";
import { PlatformLlmConfigController } from "./platform-llm-config.controller";
import { PlatformLlmConfigService } from "./platform-llm-config.service";
import { PlatformEmailConfigController } from "./platform-email-config.controller";
import { PlatformEmailConfigService } from "./platform-email-config.service";
import { AuditLogService } from "../saas/audit-log.service";
import { CommonModule } from "../common/common.module";

@Module({
  imports: [CommonModule],
  controllers: [PlatformLlmConfigController, PlatformEmailConfigController],
  providers: [PlatformLlmConfigService, PlatformEmailConfigService, AuditLogService],
  exports: [PlatformLlmConfigService, PlatformEmailConfigService],
})
export class PlatformModule {}
