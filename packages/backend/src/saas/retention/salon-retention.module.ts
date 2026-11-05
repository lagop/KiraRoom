import { Module } from "@nestjs/common";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { GdprModule } from "../gdpr/gdpr.module";
import { PlatformModule } from "../../platform/platform.module";
import { SalonRetentionScheduler } from "./salon-retention.scheduler";
import { CourtesyScheduler } from "./courtesy.scheduler";

/**
 * The retention job (salon-retention.scheduler.ts) and the end of the
 * console's courtesies (courtesy.scheduler.ts). "Borrar mi salón"
 * (SalonDeletionController) is mounted in AppModule, next to the
 * TwoFactorService it needs.
 */
@Module({
  imports: [PrismaModule, NotificationsModule, GdprModule, PlatformModule],
  // CourtesyScheduler: the end of the console's courtesies (audit 8 D6).
  providers: [SalonRetentionScheduler, CourtesyScheduler],
  exports: [SalonRetentionScheduler, CourtesyScheduler],
})
export class SalonRetentionModule {}
