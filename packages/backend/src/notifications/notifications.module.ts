import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { NotificationsService } from "./notifications.service";
import { NotificationsController } from "./notifications.controller";
import { ClientNotificationsController } from "./client-notifications.controller";
import { WebhooksController } from "./webhooks.controller";
import { NotificationsGateway } from "./notifications.gateway";
import { NotificationsScheduler } from "./notifications.scheduler";
import { EmailService } from "./services/email.service";
import { SmsService } from "./services/sms.service";
import { WhatsAppService } from "./services/whatsapp.service";
import { NotificationQueue } from "./queue/notification.queue";
import { PrismaModule } from "../common/prisma/prisma.module";
import { TranslationsModule } from "../translations/translations.module";
import { MessageBundlesModule } from "../message-bundles/message-bundles.module";

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    TranslationsModule,
    MessageBundlesModule,
  ],
  controllers: [
    NotificationsController,
    ClientNotificationsController,
    WebhooksController,
  ],
  providers: [
    NotificationsService,
    NotificationsGateway,
    NotificationsScheduler,
    EmailService,
    SmsService,
    WhatsAppService,
    NotificationQueue,
  ],
  exports: [
    NotificationsService,
    NotificationsGateway,
    NotificationsScheduler,
    EmailService,
    SmsService,
    WhatsAppService,
    NotificationQueue,
  ],
})
export class NotificationsModule {}
