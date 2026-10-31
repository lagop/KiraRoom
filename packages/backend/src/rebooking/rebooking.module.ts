import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { EmailCampaignsModule } from "../email-campaigns/email-campaigns.module";
import { RebookingController } from "./rebooking.controller";
import { ClientCadenceService } from "./client-cadence.service";
import { RebookingDispatcherService } from "./rebooking-dispatcher.service";

@Module({
  // EmailCampaignsModule: the suppression list and the signed unsubscribe
  // link, shared with the campaigns.
  imports: [PrismaModule, NotificationsModule, EmailCampaignsModule],
  controllers: [RebookingController],
  providers: [ClientCadenceService, RebookingDispatcherService],
  exports: [ClientCadenceService, RebookingDispatcherService],
})
export class RebookingModule {}
