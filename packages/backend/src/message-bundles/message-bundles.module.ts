import { forwardRef, Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { MessageBundlesController } from './message-bundles.controller';
import { MessageBundlesService } from './message-bundles.service';

@Module({
  imports: [forwardRef(() => PaymentsModule)],
  controllers: [MessageBundlesController],
  providers: [MessageBundlesService],
  exports: [MessageBundlesService],
})
export class MessageBundlesModule {}
