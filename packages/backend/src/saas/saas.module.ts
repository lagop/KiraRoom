import { Module } from "@nestjs/common";
import { SubscriptionBillingController } from "./subscription-billing.controller";
import { SubscriptionBillingService } from "./subscription-billing.service";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { SaasController } from "./saas.controller";
import { SaasService } from "./saas.service";
import { SaasAnalyticsService } from "./saas-analytics.service";
import { AuditLogService } from "./audit-log.service";
import { SaaSRetentionScheduler } from "./saas-retention.scheduler";
import { BugReportAdminController } from "./bug-report-admin.controller";
import { TenantInternalController } from "./tenant-internal.controller";
import { WeeklyDigestService } from "./weekly/weekly-digest.service";
import { WeeklyDigestScheduler } from "./weekly/weekly-digest.scheduler";
import { WeeklyDigestController } from "./weekly/weekly-digest.controller";
import { AuditLogAdminController } from "./audit/audit-log-admin.controller";
import { PrismaModule } from "../common/prisma/prisma.module";
import { PaymentsModule } from "../payments/payments.module";
import { GdprModule } from "./gdpr/gdpr.module";
import { PlatformModule } from "../platform/platform.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PasswordResetService } from "../auth/password-reset.service";
import { AuthRateLimitsService } from "../auth/abuse/auth-rate-limits.service";

@Module({
  imports: [
    PrismaModule,
    PaymentsModule,
    GdprModule,
    PlatformModule,
    // The set-password email for an owner created without a password.
    NotificationsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET"),
      }),
    }),
  ],
  providers: [
    SaasService,
    SaasAnalyticsService,
    SubscriptionBillingService,
    AuditLogService,
    SaaSRetentionScheduler,
    WeeklyDigestService,
    WeeklyDigestScheduler,
    PasswordResetService,
    AuthRateLimitsService,
  ],
  controllers: [SaasController, SubscriptionBillingController, BugReportAdminController, AuditLogAdminController, WeeklyDigestController, TenantInternalController],
  exports: [SaasService, AuditLogService],
})
export class SaasModule {}
