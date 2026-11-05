import { Global, Module } from "@nestjs/common";
import { NotificationsModule } from "../../notifications/notifications.module";
import { OpsAlertService } from "./ops-alert.service";

/** Global so the fiscal pipeline and the Resend webhook can inject it (audit 8 D15). */
@Global()
@Module({
  imports: [NotificationsModule],
  providers: [OpsAlertService],
  exports: [OpsAlertService],
})
export class OpsAlertsModule {}
