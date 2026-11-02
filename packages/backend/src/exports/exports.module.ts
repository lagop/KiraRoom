import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { ExportsController } from "./exports.controller";
import { ExportsService } from "./exports.service";
import { AnalyticsModule } from "../analytics/analytics.module";

@Module({
  imports: [PrismaModule, AnalyticsModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
