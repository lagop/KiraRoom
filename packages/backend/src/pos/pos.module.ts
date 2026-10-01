import { Module } from '@nestjs/common';
import { PosService } from './pos.service';
import { PosController } from './pos.controller';
import { ProductService } from './product.service';
import { PrismaModule } from '../common/prisma/prisma.module';
import { WalletService } from '../payments/services/wallet.service';

@Module({
  imports: [PrismaModule],
  controllers: [PosController],
  providers: [PosService, ProductService, WalletService],
  exports: [PosService],
})
export class PosModule {}
