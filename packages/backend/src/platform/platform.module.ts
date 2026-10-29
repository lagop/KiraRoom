import { Module } from "@nestjs/common";
import { PlatformLlmConfigController } from "./platform-llm-config.controller";
import { PlatformLlmConfigService } from "./platform-llm-config.service";
import { PlatformEmailConfigController } from "./platform-email-config.controller";
import { PlatformEmailConfigService } from "./platform-email-config.service";
import { PlatformStripeConfigController } from "./platform-stripe-config.controller";
import { PlatformStripeConfigService } from "./platform-stripe-config.service";
import { AuditLogService } from "../saas/audit-log.service";
import { CommonModule } from "../common/common.module";

@Module({
  imports: [CommonModule],
  controllers: [PlatformLlmConfigController, PlatformEmailConfigController, PlatformStripeConfigController],
  providers: [PlatformLlmConfigService, PlatformEmailConfigService, PlatformStripeConfigService, AuditLogService],
  exports: [PlatformLlmConfigService, PlatformEmailConfigService, PlatformStripeConfigService],
})
export class PlatformModule {}
