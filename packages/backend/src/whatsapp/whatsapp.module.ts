import { Module } from "@nestjs/common";
import { WhatsAppController, MetaWebhookController } from "./whatsapp.controller";
import { ChannelsWebhookController } from "./channels-webhook.controller";
import { WhatsAppService } from "./whatsapp.service";
import { MetaCloudApiClient } from "./meta-cloud-api.client";
import { TelegramChannelProvider } from "../virtual-receptionist/channels/telegram-channel.provider";
import { MessageBundlesModule } from "../message-bundles/message-bundles.module";

@Module({
  imports: [MessageBundlesModule],
  controllers: [WhatsAppController, MetaWebhookController, ChannelsWebhookController],
  providers: [WhatsAppService, MetaCloudApiClient, TelegramChannelProvider],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}