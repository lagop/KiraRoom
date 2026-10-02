import { Module } from '@nestjs/common';
import { WaitListController } from './wait-list.controller';
import { WaitListService } from './wait-list.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { WhatsAppMessagingModule } from '../whatsapp/whatsapp-messaging.module';

@Module({
  // Notices go out through the same email / SMS services as the rest of
  // the app, and through the salon's own WhatsApp number (templates).
  imports: [NotificationsModule, WhatsAppMessagingModule],
  controllers: [WaitListController],
  providers: [WaitListService],
  exports: [WaitListService],
})
export class WaitListModule {}
