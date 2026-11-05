import { Module } from "@nestjs/common";
import { ReviewsService } from "./reviews.service";
import {
  ReviewsController,
  ReviewsPublicController,
  ReviewsPublicListController,
  ReviewsAnalyticsController,
} from "./reviews.controller";
import { NotificationsModule } from "../notifications/notifications.module";
import { EmailCampaignsModule } from "../email-campaigns/email-campaigns.module";
import { AuditLogService } from "../saas/audit-log.service";
import { WhatsAppMessagingModule } from "../whatsapp/whatsapp-messaging.module";

@Module({
  // FeatureFlagService comes from the global FeatureFlagModule.
  // EmailCampaignsModule: the salon's email suppression list.
  // WhatsAppMessagingModule: the review request template, from the salon's number.
  imports: [NotificationsModule, EmailCampaignsModule, WhatsAppMessagingModule],
  controllers: [
    ReviewsController,
    ReviewsPublicController,
    ReviewsPublicListController,
    ReviewsAnalyticsController,
  ],
  // Moderation is audit-logged.
  providers: [ReviewsService, AuditLogService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
