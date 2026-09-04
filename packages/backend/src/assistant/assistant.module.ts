import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../common/prisma/prisma.module';
import { VirtualReceptionistModule } from '../virtual-receptionist/virtual-receptionist.module';
import { PlatformModule } from '../platform/platform.module';
import { FeatureFlagModule } from '../common/feature-flags/feature-flag.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AssistantGateway } from './assistant.gateway';
import { SalonCopilotToolsService } from './tools/salon-copilot-tools';
import { ActionApprovalService } from './action-approval.service';
import { AssistantTierService } from './assistant-tier.service';
import { AssistantSoftLaunchGuard } from './assistant-soft-launch.guard';

/**
 * P2A-staff-copilot: the in-app assistant module.
 *
 * Imports the existing LLM infrastructure (VirtualReceptionistModule →
 * LLMService) and the PlatformModule (for the platform-wide provider
 * config) so we re-use the same Anthropic / OpenAI / Google / MiniMax
 * route the customer chatbot uses. The copilot has its own tool set
 * and its own conversation tables.
 */
@Module({
  imports: [ConfigModule, PrismaModule, VirtualReceptionistModule, PlatformModule, FeatureFlagModule],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantGateway,
    SalonCopilotToolsService,
    ActionApprovalService,
    AssistantTierService,
    AssistantSoftLaunchGuard,
  ],
  exports: [AssistantService, SalonCopilotToolsService, ActionApprovalService, AssistantTierService],
})
export class AssistantModule {}
