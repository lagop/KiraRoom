import { Module } from "@nestjs/common";
import { WhatsAppController, MetaWebhookController } from "./whatsapp.controller";
import { ChannelsWebhookController } from "./channels-webhook.controller";
import { WhatsAppService } from "./whatsapp.service";
import { MessageBundlesModule } from "../message-bundles/message-bundles.module";
import { VirtualReceptionistModule } from "../virtual-receptionist/virtual-receptionist.module";
import { WhatsAppReceptionistService } from "./whatsapp-receptionist.service";
import { WhatsAppMessagingModule } from "./whatsapp-messaging.module";

@Module({
  imports: [MessageBundlesModule, VirtualReceptionistModule, WhatsAppMessagingModule],
  controllers: [WhatsAppController, MetaWebhookController, ChannelsWebhookController],
  // MetaCloudApiClient comes from WhatsAppMessagingModule; the Messenger,
  // Instagram and Telegram receptionist (ChannelReceptionistService) from
  // VirtualReceptionistModule.
  providers: [WhatsAppService, WhatsAppReceptionistService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}