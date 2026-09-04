import { Module } from "@nestjs/common";
import { ReviewsService } from "./reviews.service";
import {
  ReviewsController,
  ReviewsPublicController,
  ReviewsAnalyticsController,
} from "./reviews.controller";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [NotificationsModule],
  controllers: [ReviewsController, ReviewsPublicController, ReviewsAnalyticsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}