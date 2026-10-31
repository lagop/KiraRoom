import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { TimeOffController } from "./time-off.controller";
import { TimeOffService } from "./time-off.service";

@Module({
  imports: [PrismaModule],
  controllers: [TimeOffController],
  providers: [TimeOffService],
  exports: [TimeOffService],
})
export class TimeOffModule {}
