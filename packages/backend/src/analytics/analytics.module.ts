import { Module } from "@nestjs/common";
import { AnalyticsService } from "./analytics.service";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsFlagsService } from "./analytics-flags.service";
import { PrismaModule } from "../common/prisma/prisma.module";
import { ProfessionalsModule } from "../professionals/professionals.module";

@Module({
  imports: [PrismaModule, ProfessionalsModule],
  providers: [AnalyticsService, AnalyticsFlagsService],
  controllers: [AnalyticsController],
  exports: [AnalyticsService, AnalyticsFlagsService],
})
export class AnalyticsModule {}
