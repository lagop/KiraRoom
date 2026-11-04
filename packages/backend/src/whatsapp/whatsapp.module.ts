import { Module } from "@nestjs/common";
import { WhatsAppController, MetaWebhookController, PlatformMetaStatusController } from "./whatsapp.controller";
import { ChannelsWebhookController } from "./channels-webhook.controller";
import { WhatsAppService } from "./whatsapp.service";
import { MessageBundlesModule } from "../message-bundles/message-bundles.module";
import { VirtualReceptionistModule } from "../virtual-receptionist/virtual-receptionist.module";
import { WhatsAppReceptionistService } from "./whatsapp-receptionist.service";
import { WhatsAppMessagingModule } from "./whatsapp-messaging.module";
import { ConsentModule } from "../consent/consent.module";
import { WhatsAppCampaignsController } from "./campaigns/whatsapp-campaigns.controller";
import { WhatsAppCampaignsService } from "./campaigns/whatsapp-campaigns.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { ChannelAttentionScheduler } from "../channel-health/channel-attention.scheduler";

@Module({
  imports: [MessageBundlesModule, VirtualReceptionistModule, WhatsAppMessagingModule, ConsentModule, NotificationsModule],
  controllers: [WhatsAppController, WhatsAppCampaignsController, MetaWebhookController, ChannelsWebhookController, PlatformMetaStatusController],
  // MetaCloudApiClient comes from WhatsAppMessagingModule; the Messenger,
  // Instagram and Telegram receptionist (ChannelReceptionistService) from
  // VirtualReceptionistModule.
  // ChannelAttentionScheduler tells owners when Meta or Telegram refused a
  // channel token (marked by ChannelHealthService, from WhatsAppMessagingModule).
  providers: [WhatsAppService, WhatsAppReceptionistService, WhatsAppCampaignsService, ChannelAttentionScheduler],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}