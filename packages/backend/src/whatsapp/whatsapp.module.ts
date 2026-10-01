import { Module } from "@nestjs/common";
import { WhatsAppController, MetaWebhookController } from "./whatsapp.controller";
import { ChannelsWebhookController } from "./channels-webhook.controller";
import { WhatsAppService } from "./whatsapp.service";
import { TelegramChannelProvider } from "../virtual-receptionist/channels/telegram-channel.provider";
import { MessageBundlesModule } from "../message-bundles/message-bundles.module";
import { VirtualReceptionistModule } from "../virtual-receptionist/virtual-receptionist.module";
import { WhatsAppReceptionistService } from "./whatsapp-receptionist.service";
import { WhatsAppMessagingModule } from "./whatsapp-messaging.module";

@Module({
  imports: [MessageBundlesModule, VirtualReceptionistModule, WhatsAppMessagingModule],
  controllers: [WhatsAppController, MetaWebhookController, ChannelsWebhookController],
  // MetaCloudApiClient comes from WhatsAppMessagingModule.
  providers: [WhatsAppService, TelegramChannelProvider, WhatsAppReceptionistService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}