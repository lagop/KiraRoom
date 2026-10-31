import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TimeOffController } from "./time-off.controller";
import { TimeOffService } from "./time-off.service";
import { TimeOffRequestsService } from "./time-off-requests.service";

@Module({
  // NotificationsModule: the panel notifications about requests.
  imports: [PrismaModule, NotificationsModule],
  controllers: [TimeOffController],
  providers: [TimeOffService, TimeOffRequestsService],
  exports: [TimeOffService],
})
export class TimeOffModule {}
