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

@Module({
  // PlatformModule: StripeService reads KiraRoom's account settings from it.
  // InvoicesModule: a till discount on an appointment already invoiced is
  // issued as a rectificativa (PosService.invoicesToRectify).
  imports: [PrismaModule, LoyaltyModule, PlatformModule, InvoicesModule],
  controllers: [PosController],
  // ProductService still uses StripeService (product payments); PosService no
  // longer does. Removing it from here took the API down on 2026-10-01.
  providers: [PosService, ProductService, StripeService, WalletService],
  exports: [PosService],
})
export class PosModule {}
