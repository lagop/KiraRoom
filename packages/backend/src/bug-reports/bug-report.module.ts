import { Module } from "@nestjs/common";
import { BugReportController } from "./bug-report.controller";
import { BugReportService } from "./bug-report.service";
import { BugReportRetentionScheduler } from "./bug-report-retention";
import { NotificationsModule } from "../notifications/notifications.module";
import { PrismaModule } from "../common/prisma/prisma.module";

@Module({
  imports: [NotificationsModule, PrismaModule],
  controllers: [BugReportController],
  providers: [BugReportService, BugReportRetentionScheduler],
})
export class BugReportModule {}
