import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { SaasController } from "./saas.controller";
import { SaasService } from "./saas.service";
import { AuditLogService } from "./audit-log.service";
import { SaaSRetentionScheduler } from "./saas-retention.scheduler";
import { BugReportAdminController } from "./bug-report-admin.controller";
import { PrismaModule } from "../common/prisma/prisma.module";
import { PaymentsModule } from "../payments/payments.module";
import { GdprModule } from "./gdpr/gdpr.module";

@Module({
  imports: [
    PrismaModule,
    PaymentsModule,
    GdprModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET"),
      }),
    }),
  ],
  providers: [SaasService, AuditLogService, SaaSRetentionScheduler],
  controllers: [SaasController, BugReportAdminController],
  exports: [SaasService, AuditLogService],
})
export class SaasModule {}
