import { Module } from "@nestjs/common";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { GdprModule } from "../gdpr/gdpr.module";
import { SalonRetentionScheduler } from "./salon-retention.scheduler";

/**
 * The retention job (salon-retention.scheduler.ts). "Borrar mi salón"
 * (SalonDeletionController) is mounted in AppModule, next to the
 * TwoFactorService it needs.
 */
@Module({
  imports: [PrismaModule, NotificationsModule, GdprModule],
  providers: [SalonRetentionScheduler],
  exports: [SalonRetentionScheduler],
})
export class SalonRetentionModule {}
