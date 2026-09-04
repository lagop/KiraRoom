import { Module } from "@nestjs/common";
import { BugReportController } from "./bug-report.controller";
import { BugReportService } from "./bug-report.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { PrismaModule } from "../common/prisma/prisma.module";

@Module({
  imports: [NotificationsModule, PrismaModule],
  controllers: [BugReportController],
  providers: [BugReportService],
})
export class BugReportModule {}
