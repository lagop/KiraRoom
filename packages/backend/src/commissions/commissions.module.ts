import { Module } from '@nestjs/common';
import { CommissionsService } from './commissions.service';
import { CommissionsController } from './commissions.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AuditLogService } from '../saas/audit-log.service';

@Module({
  imports: [PrismaModule],
  controllers: [CommissionsController],
  // AuditLogService: payouts, "Deshacer" and the settings are audit-logged.
  providers: [CommissionsService, AuditLogService],
  exports: [CommissionsService],
})
export class CommissionsModule {}
