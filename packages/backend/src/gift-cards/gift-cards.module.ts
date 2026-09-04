import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { GiftCardsController } from "./gift-cards.controller";
import { GiftCardsService } from "./gift-cards.service";

@Module({
  imports: [PrismaModule],
  controllers: [GiftCardsController],
  providers: [GiftCardsService],
  exports: [GiftCardsService],
})
export class GiftCardsModule {}
