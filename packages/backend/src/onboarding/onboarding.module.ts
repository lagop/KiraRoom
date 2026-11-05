import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { OnboardingDetectorService } from "./onboarding-detector.service";
import { OnboardingStepSeeder } from "./onboarding-step.seeder";
import { TestBookingCleanupService } from "./test-booking-cleanup.service";
import { OnboardingNudgeService } from "./onboarding-nudge.service";
import { OnboardingNudgeController } from "./onboarding-nudge.controller";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  // NotificationsModule: the day-2 reminder's email (audit 7 D17).
  imports: [PrismaModule, NotificationsModule],
  controllers: [OnboardingController, OnboardingNudgeController],
  providers: [
    OnboardingService,
    OnboardingDetectorService,
    OnboardingStepSeeder,
    TestBookingCleanupService,
    OnboardingNudgeService,
  ],
  exports: [OnboardingDetectorService, OnboardingService],
})
export class OnboardingModule {}