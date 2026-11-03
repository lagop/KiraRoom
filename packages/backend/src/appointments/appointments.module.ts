import { Module } from "@nestjs/common";
import { AppointmentsController } from "./appointments.controller";
import { PublicViewerModule } from "../common/tenancy/public-viewer.service";
import { AppointmentsService } from "./appointments.service";
import { AppointmentServicesController } from "./appointment-services.controller";
import { AppointmentServicesService } from "./appointment-services.service";
import { HomeSummaryService } from "./home-summary.service";
import { AnalyticsModule } from "../analytics/analytics.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TranslationsModule } from "../translations/translations.module";
import { ConsentModule } from "../consent/consent.module";
import { RebookingModule } from "../rebooking/rebooking.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { WaitListModule } from "../wait-list/wait-list.module";
import { LoyaltyModule } from "../loyalty/loyalty.module";
import { WhatsAppMessagingModule } from "../whatsapp/whatsapp-messaging.module";

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
    // Inicio (HomeSummaryService): the location filter and today's occupancy, as in Analítica.
    AnalyticsModule,
  ],
  controllers: [AppointmentsController, AppointmentServicesController],
  providers: [AppointmentsService, AppointmentServicesService, HomeSummaryService],
  exports: [AppointmentsService, AppointmentServicesService, HomeSummaryService],
})
export class AppointmentsModule {}
