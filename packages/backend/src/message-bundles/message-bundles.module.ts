import { forwardRef, Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { MessageBundlesController } from './message-bundles.controller';
import { MessageBundlesService } from './message-bundles.service';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [forwardRef(() => PaymentsModule), PlatformModule],
  controllers: [MessageBundlesController],
  providers: [MessageBundlesService],
  exports: [MessageBundlesService],
})
export class MessageBundlesModule {}
