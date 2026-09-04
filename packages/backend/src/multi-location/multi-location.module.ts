import { Module } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module";
import {
  MultiLocationController,
  ConsolidatedReportsController,
} from "./multi-location.controller";
import { MultiLocationService } from "./multi-location.service";

@Module({
  imports: [PaymentsModule],
  controllers: [MultiLocationController, ConsolidatedReportsController],
  providers: [MultiLocationService],
  exports: [MultiLocationService],
})
export class MultiLocationModule {}