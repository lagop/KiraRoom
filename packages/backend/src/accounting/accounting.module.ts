import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../common/prisma/prisma.module";
import { CommonModule } from "../common/common.module";
import { AccountingController } from "./accounting.controller";
import { AccountingService } from "./accounting.service";
import { HoldedAdapter } from "./providers/holded.adapter";
import { SageAdapter } from "./providers/sage.adapter";
import { A3Adapter } from "./providers/a3.adapter";
import { NCSAdapter } from "./providers/ncs.adapter";

@Module({
  imports: [ConfigModule, PrismaModule, CommonModule],
  controllers: [AccountingController],
  providers: [AccountingService, HoldedAdapter, SageAdapter, A3Adapter, NCSAdapter],
  exports: [AccountingService],
})
export class AccountingModule {}