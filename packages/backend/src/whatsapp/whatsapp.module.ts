import { Module } from "@nestjs/common";
import { WhatsAppController, MetaWebhookController } from "./whatsapp.controller";
import { ChannelsWebhookController } from "./channels-webhook.controller";
import { WhatsAppService } from "./whatsapp.service";
import { MetaCloudApiClient } from "./meta-cloud-api.client";
import { TelegramChannelProvider } from "../virtual-receptionist/channels/telegram-channel.provider";
import { MessageBundlesModule } from "../message-bundles/message-bundles.module";
import { VirtualReceptionistModule } from "../virtual-receptionist/virtual-receptionist.module";
import { WhatsAppReceptionistService } from "./whatsapp-receptionist.service";

@Module({
  imports: [MessageBundlesModule, VirtualReceptionistModule],
  controllers: [WhatsAppController, MetaWebhookController, ChannelsWebhookController],
  providers: [WhatsAppService, MetaCloudApiClient, TelegramChannelProvider, WhatsAppReceptionistService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}