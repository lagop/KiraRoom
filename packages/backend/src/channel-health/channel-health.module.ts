import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { ChannelHealthService } from "./channel-health.service";

/**
 * Marking a channel whose token Meta or Telegram refused. Prisma only, so
 * WhatsAppMessagingModule (imported by NotificationsModule) and the
 * receptionist's channel providers can both use it without a module cycle.
 * Telling the owner is ChannelAttentionScheduler's job (WhatsAppModule).
 */
@Module({
  imports: [PrismaModule],
  providers: [ChannelHealthService],
  exports: [ChannelHealthService],
})
export class ChannelHealthModule {}
