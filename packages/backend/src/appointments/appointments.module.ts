import { Module } from "@nestjs/common";
import { AppointmentsController } from "./appointments.controller";
import { PublicViewerModule } from "../common/tenancy/public-viewer.service";
import { AppointmentsService } from "./appointments.service";
import { AppointmentServicesController } from "./appointment-services.controller";
import { AppointmentServicesService } from "./appointment-services.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { TranslationsModule } from "../translations/translations.module";
import { ConsentModule } from "../consent/consent.module";
import { RebookingModule } from "../rebooking/rebooking.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { WaitListModule } from "../wait-list/wait-list.module";
import { LoyaltyModule } from "../loyalty/loyalty.module";
import { WhatsAppMessagingModule } from "../whatsapp/whatsapp-messaging.module";
import { DepositsService } from "./deposits/deposits.service";
import { StripeConnectController, StripeConnectWebhookController } from "./deposits/deposits.controller";

@Module({
  imports: [
    // Completing, paying or cancelling an appointment moves loyalty points.
    LoyaltyModule,
    // Confirmations, cancellations and changes through the salon's
    // WhatsApp Business number (approved templates).
    WhatsAppMessagingModule,
    PublicViewerModule,
    NotificationsModule,
    TranslationsModule,
    ConsentModule,
    RebookingModule,
    InvoicesModule,
    WaitListModule,
  ],
  controllers: [
    AppointmentsController,
    AppointmentServicesController,
    StripeConnectController,
    StripeConnectWebhookController,
  ],
  providers: [AppointmentsService, AppointmentServicesService, DepositsService],
  exports: [AppointmentsService, AppointmentServicesService],
})
export class AppointmentsModule {}
