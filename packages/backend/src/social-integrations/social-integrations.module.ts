import { Module } from '@nestjs/common';
import { SocialIntegrationsService } from './social-integrations.service';
import { SocialIntegrationsController } from './social-integrations.controller';
import { PrismaModule } from '../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [SocialIntegrationsService],
  controllers: [SocialIntegrationsController],
  exports: [SocialIntegrationsService],
})
export class SocialIntegrationsModule {}
