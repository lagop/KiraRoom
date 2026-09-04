import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { SmsController } from "./sms.controller";

@Module({
  imports: [NotificationsModule],
  controllers: [SmsController],
})
export class SmsModule {}
