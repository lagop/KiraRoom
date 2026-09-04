import { Module } from "@nestjs/common";
import { EmailCampaignsController } from "./email-campaigns.controller";
import { ResendWebhooksController } from "./resend-webhooks.controller";
import { EmailCampaignsService } from "./email-campaigns.service";
import { EmailCampaignsScheduler } from "./email-campaigns.scheduler";
import { PrismaModule } from "../common/prisma/prisma.module";
import { EmailService } from "../notifications/services/email.service";
import { PromotionsModule } from "../promotions/promotions.module";
import { TranslationsModule } from "../translations/translations.module";

@Module({
  imports: [PrismaModule, PromotionsModule, TranslationsModule],
  controllers: [EmailCampaignsController, ResendWebhooksController],
  providers: [EmailCampaignsService, EmailCampaignsScheduler, EmailService],
  exports: [EmailCampaignsService],
})
export class EmailCampaignsModule {}
