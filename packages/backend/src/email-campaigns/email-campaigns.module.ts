import { Module } from "@nestjs/common";
import { EmailCampaignsController } from "./email-campaigns.controller";
import { ResendWebhooksController } from "./resend-webhooks.controller";
import { EmailUnsubscribeController } from "./email-unsubscribe.controller";
import { EmailCampaignsService } from "./email-campaigns.service";
import { EmailCampaignsScheduler } from "./email-campaigns.scheduler";
import { EmailSuppressionService } from "./email-suppression.service";
import { EmailUnsubscribeService } from "./email-unsubscribe.service";
import { ResendEventsService } from "./resend-events.service";
import { PrismaModule } from "../common/prisma/prisma.module";
import { EmailService } from "../notifications/services/email.service";
import { PromotionsModule } from "../promotions/promotions.module";
import { TranslationsModule } from "../translations/translations.module";
import { ConsentModule } from "../consent/consent.module";

@Module({
  imports: [PrismaModule, PromotionsModule, TranslationsModule, ConsentModule],
  controllers: [EmailCampaignsController, ResendWebhooksController, EmailUnsubscribeController],
  providers: [
    EmailCampaignsService,
    EmailCampaignsScheduler,
    EmailService,
    EmailSuppressionService,
    EmailUnsubscribeService,
    ResendEventsService,
  ],
  exports: [EmailCampaignsService],
})
export class EmailCampaignsModule {}
