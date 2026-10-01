import { Module } from '@nestjs/common';
import { PosService } from './pos.service';
import { PosController } from './pos.controller';
import { ProductService } from './product.service';
import { PrismaModule } from '../common/prisma/prisma.module';
import { WalletService } from '../payments/services/wallet.service';
import { StripeService } from '../payments/services/stripe.service';

@Module({
  imports: [PrismaModule],
  controllers: [PosController],
  // ProductService still uses StripeService (product payments); PosService no
  // longer does. Removing it from here took the API down on 2026-10-01.
  providers: [PosService, ProductService, StripeService, WalletService],
  exports: [PosService],
})
export class PosModule {}
