import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { RebookingModule } from "../rebooking/rebooking.module";
import { AuditLogService } from "../saas/audit-log.service";
import { AdminClientsController } from "./clients/clients.controller";
import { AdminClientsService } from "./clients/clients.service";
import { ClientMergeService } from "./clients/client-merge.service";
import { AdminProfessionalsController } from "./professionals/professionals.controller";
import { AdminProfessionalsService } from "./professionals/professionals.service";
import { AdminSettingsController } from "./settings/settings.controller";
import { AdminSettingsService } from "./settings/settings.service";

@Module({
  // RebookingModule: a merged client's cadence is recomputed afterwards.
  imports: [PrismaModule, RebookingModule],
  controllers: [
    AdminClientsController,
    AdminProfessionalsController,
    AdminSettingsController,
  ],
  providers: [
    AdminClientsService,
    ClientMergeService,
    AuditLogService,
    AdminProfessionalsService,
    AdminSettingsService,
  ],
  exports: [],
})
export class AdminModule {}
