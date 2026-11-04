import { Module } from "@nestjs/common";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { GdprController } from "./gdpr.controller";
import { AuditLogService } from "../audit-log.service";
import { GdprService } from "./gdpr.service";

@Module({
  imports: [PrismaModule],
  controllers: [GdprController],
  // AuditLogService: the console's erasure is on the audit log (audit 8, C9).
  providers: [GdprService, AuditLogService],
  exports: [GdprService],
})
export class GdprModule {}
