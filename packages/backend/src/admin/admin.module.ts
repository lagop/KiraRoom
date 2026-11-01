import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { AdminClientsController } from "./clients/clients.controller";
import { AdminClientsService } from "./clients/clients.service";
import { AdminClientGdprController } from "./clients/client-gdpr.controller";
import { ClientGdprService } from "../clients/client-gdpr.service";
import { AuditLogService } from "../saas/audit-log.service";
import { AdminProfessionalsController } from "./professionals/professionals.controller";
import { AdminProfessionalsService } from "./professionals/professionals.service";
import { AdminSettingsController } from "./settings/settings.controller";
import { AdminSettingsService } from "./settings/settings.service";

@Module({
  imports: [PrismaModule],
  controllers: [
    AdminClientsController,
    AdminClientGdprController,
    AdminProfessionalsController,
    AdminSettingsController,
  ],
  providers: [
    AdminClientsService,
    ClientGdprService,
    AuditLogService,
    AdminProfessionalsService,
    AdminSettingsService,
  ],
  exports: [],
})
export class AdminModule {}
