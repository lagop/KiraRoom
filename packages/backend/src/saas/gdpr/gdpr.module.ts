import { Module } from "@nestjs/common";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PaymentsModule } from "../../payments/payments.module";
import { AuditLogService } from "../audit-log.service";
import { GdprController } from "./gdpr.controller";
import { GdprService } from "./gdpr.service";
import { GdprConsoleService } from "./gdpr-console.service";

@Module({
  // PaymentsModule: the console's erasure cancels the Stripe subscription first.
  imports: [PrismaModule, PaymentsModule],
  controllers: [GdprController],
  providers: [GdprService, GdprConsoleService, AuditLogService],
  exports: [GdprService],
})
export class GdprModule {}
