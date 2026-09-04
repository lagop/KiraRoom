import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RebookingController } from "./rebooking.controller";
import { ClientCadenceService } from "./client-cadence.service";
import { RebookingDispatcherService } from "./rebooking-dispatcher.service";

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [RebookingController],
  providers: [ClientCadenceService, RebookingDispatcherService],
  exports: [ClientCadenceService, RebookingDispatcherService],
})
export class RebookingModule {}