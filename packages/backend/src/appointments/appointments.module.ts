import { Module } from "@nestjs/common";
import { AppointmentsController } from "./appointments.controller";
import { AppointmentsService } from "./appointments.service";
import { AppointmentServicesController } from "./appointment-services.controller";
import { AppointmentServicesService } from "./appointment-services.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { TranslationsModule } from "../translations/translations.module";
import { ConsentModule } from "../consent/consent.module";
import { RebookingModule } from "../rebooking/rebooking.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { WaitListModule } from "../wait-list/wait-list.module";

@Module({
  imports: [
    NotificationsModule,
    TranslationsModule,
    ConsentModule,
    RebookingModule,
    InvoicesModule,
    WaitListModule,
  ],
  controllers: [AppointmentsController, AppointmentServicesController],
  providers: [AppointmentsService, AppointmentServicesService],
  exports: [AppointmentsService, AppointmentServicesService],
})
export class AppointmentsModule {}
