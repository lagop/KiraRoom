import { Module } from '@nestjs/common';
import { PosService } from './pos.service';
import { PosController } from './pos.controller';
import { ProductService } from './product.service';
import { PrismaModule } from '../common/prisma/prisma.module';
import { WalletService } from '../payments/services/wallet.service';
import { StripeService } from '../payments/services/stripe.service';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PlatformModule } from '../platform/platform.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';

@Module({
  // PlatformModule: StripeService reads KiraRoom's account settings from it.
  // InvoicesModule: a till discount on an appointment already invoiced is
  // issued as a rectificativa (PosService.invoicesToRectify).
  // GiftCardsModule: gift cards are sold, redeemed and refunded at the till.
  imports: [PrismaModule, LoyaltyModule, PlatformModule, InvoicesModule, GiftCardsModule],
  controllers: [PosController],
  // StripeService is kept provided: removing it from here took the API down
  // on 2026-10-01 (ProductService injected it then; it no longer does).
  providers: [PosService, ProductService, StripeService, WalletService],
  exports: [PosService],
})
export class PosModule {}
