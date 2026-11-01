import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PublicViewerModule } from '../common/tenancy/public-viewer.service';
import { ProfessionalsController } from './professionals.controller';
import { ProfessionalsService } from './professionals.service';
// The legacy writes (POST/PUT/DELETE /professionals) go through the same
// service as the panel's, so both have the same rules. It only needs Prisma.
import { AdminProfessionalsService } from '../admin/professionals/professionals.service';

@Module({
  imports: [PrismaModule, OnboardingModule, PublicViewerModule],
  controllers: [ProfessionalsController],
  providers: [ProfessionalsService, AdminProfessionalsService],
  exports: [ProfessionalsService],
})
export class ProfessionalsModule {}
