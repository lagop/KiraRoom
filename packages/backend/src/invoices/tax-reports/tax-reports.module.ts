import { Module } from "@nestjs/common";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { TaxReportsController } from "./tax-reports.controller";
import { TaxReportsService } from "./tax-reports.service";

@Module({
  imports: [PrismaModule],
  controllers: [TaxReportsController],
  providers: [TaxReportsService],
  exports: [TaxReportsService],
})
export class TaxReportsModule {}
