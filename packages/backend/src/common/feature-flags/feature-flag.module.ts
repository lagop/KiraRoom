import { Global, Module } from '@nestjs/common';
import { FeatureFlagService } from './feature-flag.service';
import { PaymentsModule } from '../../payments/payments.module';

@Global()
@Module({
  imports: [PaymentsModule],
  providers: [FeatureFlagService],
  exports: [FeatureFlagService],
})
export class FeatureFlagModule {}
