import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { AdminClientsController } from "./clients/clients.controller";
import { AdminClientsService } from "./clients/clients.service";
import { AdminProfessionalsController } from "./professionals/professionals.controller";
import { AdminProfessionalsService } from "./professionals/professionals.service";
import { AdminSettingsController } from "./settings/settings.controller";
import { AdminSettingsService } from "./settings/settings.service";

@Module({
  imports: [PrismaModule],
  controllers: [
    AdminClientsController,
    AdminProfessionalsController,
    AdminSettingsController,
  ],
  providers: [
    AdminClientsService,
    AdminProfessionalsService,
    AdminSettingsService,
  ],
  exports: [],
})
export class AdminModule {}
