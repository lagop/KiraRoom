import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { ExportsController } from "./exports.controller";
import { ExportsService } from "./exports.service";

@Module({
  imports: [PrismaModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
