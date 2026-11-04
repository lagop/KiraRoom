import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { MetaCloudApiClient } from "./meta-cloud-api.client";
import { WhatsAppTemplateService } from "./whatsapp-template.service";
import { ChannelHealthModule } from "../channel-health/channel-health.module";

/**
 * Sending through a salon's WhatsApp Business number, with no dependency on
 * the receptionist: NotificationsModule needs it for reminders, and the
 * receptionist module already depends on NotificationsModule, so importing
 * the whole WhatsAppModule there would be a cycle.
 */
@Module({
  imports: [PrismaModule, ChannelHealthModule],
  providers: [MetaCloudApiClient, WhatsAppTemplateService],
  exports: [MetaCloudApiClient, WhatsAppTemplateService, ChannelHealthModule],
})
export class WhatsAppMessagingModule {}
