import { Module } from '@nestjs/common';
import { UpsellController } from './upsell.controller';
import { UpsellService } from './upsell.service';

@Module({
  controllers: [UpsellController],
  providers: [UpsellService],
  exports: [UpsellService],
})
export class UpsellModule {}
