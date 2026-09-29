import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PublicViewerModule } from '../common/tenancy/public-viewer.service';
import { ProfessionalsController } from './professionals.controller';
import { ProfessionalsService } from './professionals.service';

@Module({
  imports: [PrismaModule, OnboardingModule, PublicViewerModule],
  controllers: [ProfessionalsController],
  providers: [ProfessionalsService],
  exports: [ProfessionalsService],
})
export class ProfessionalsModule {}
