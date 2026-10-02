import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { CommonModule } from "../common/common.module";
import { AccountingController } from "./accounting.controller";
import { AccountingService } from "./accounting.service";
import { AccountingScheduler } from "./accounting.scheduler";
import { InvoiceBookService } from "./invoice-book.service";
import { HoldedAdapter } from "./providers/holded.adapter";

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [AccountingController],
  providers: [AccountingService, AccountingScheduler, InvoiceBookService, HoldedAdapter],
  exports: [AccountingService],
})
export class AccountingModule {}
