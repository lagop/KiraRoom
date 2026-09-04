import { Module } from '@nestjs/common';
import { WaitListController } from './wait-list.controller';
import { WaitListService } from './wait-list.service';

@Module({
  controllers: [WaitListController],
  providers: [WaitListService],
  exports: [WaitListService],
})
export class WaitListModule {}
