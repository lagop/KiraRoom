import { Module } from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyController, LoyaltyPortalController } from './loyalty.controller';
import { PrismaModule } from '../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  // The portal controller first: "loyalty/me" must not be taken for a
  // member id by a staff route.
  controllers: [LoyaltyPortalController, LoyaltyController],
  providers: [LoyaltyService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
