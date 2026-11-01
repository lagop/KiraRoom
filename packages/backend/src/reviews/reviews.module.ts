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

@Module({
  // FeatureFlagService comes from the global FeatureFlagModule.
  // EmailCampaignsModule: the salon's email suppression list.
  imports: [NotificationsModule, EmailCampaignsModule],
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
