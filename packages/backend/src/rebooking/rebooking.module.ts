import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { EmailCampaignsModule } from "../email-campaigns/email-campaigns.module";
import { ConsentModule } from "../consent/consent.module";
import { RebookingController } from "./rebooking.controller";
import { ClientCadenceService } from "./client-cadence.service";
import { RebookingDispatcherService } from "./rebooking-dispatcher.service";

@Module({
  // EmailCampaignsModule: the suppression list and the signed unsubscribe
  // link, shared with the campaigns. ConsentModule: the client file's reach
  // rule (assertClientInReach) on the per-client routes.
  imports: [PrismaModule, NotificationsModule, EmailCampaignsModule, ConsentModule],
  controllers: [RebookingController],
  providers: [ClientCadenceService, RebookingDispatcherService],
  exports: [ClientCadenceService, RebookingDispatcherService],
})
export class RebookingModule {}
