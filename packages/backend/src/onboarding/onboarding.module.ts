import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { OnboardingDetectorService } from "./onboarding-detector.service";
import { OnboardingStepSeeder } from "./onboarding-step.seeder";
import { TestBookingCleanupService } from "./test-booking-cleanup.service";

@Module({
  imports: [PrismaModule],
  controllers: [OnboardingController],
  providers: [
    OnboardingService,
    OnboardingDetectorService,
    OnboardingStepSeeder,
    TestBookingCleanupService,
  ],
  exports: [OnboardingDetectorService, OnboardingService],
})
export class OnboardingModule {}