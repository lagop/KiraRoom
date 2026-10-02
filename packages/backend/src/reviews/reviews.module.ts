import { Module } from "@nestjs/common";
import { ReviewsService } from "./reviews.service";
import {
  ReviewsController,
  ReviewsPublicController,
  ReviewsPublicListController,
  ReviewsAnalyticsController,
} from "./reviews.controller";
import { NotificationsModule } from "../notifications/notifications.module";
import { WhatsAppMessagingModule } from "../whatsapp/whatsapp-messaging.module";

@Module({
  // FeatureFlagService comes from the global FeatureFlagModule.
  imports: [NotificationsModule, WhatsAppMessagingModule],
  controllers: [
    ReviewsController,
    ReviewsPublicController,
    ReviewsPublicListController,
    ReviewsAnalyticsController,
  ],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
