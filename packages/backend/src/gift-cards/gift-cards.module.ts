import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { GiftCardsController } from "./gift-cards.controller";
import { GiftCardsService } from "./gift-cards.service";

@Module({
  // EmailService: the card is emailed to its recipient.
  imports: [PrismaModule, NotificationsModule],
  controllers: [GiftCardsController],
  providers: [GiftCardsService],
  // The POS sells, redeems and refunds through GiftCardsService.
  exports: [GiftCardsService],
})
export class GiftCardsModule {}
