import { forwardRef, Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { MessageBundlesController } from './message-bundles.controller';
import { MessageBundlesService } from './message-bundles.service';
import { PlatformModule } from '../platform/platform.module';
import { AuditLogService } from '../saas/audit-log.service';

@Module({
  imports: [forwardRef(() => PaymentsModule), PlatformModule],
  controllers: [MessageBundlesController],
  // AuditLogService: the console's credit top-ups are audit-logged (audit 8, C9).
  providers: [MessageBundlesService, AuditLogService],
  exports: [MessageBundlesService],
})
export class MessageBundlesModule {}
