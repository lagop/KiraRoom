import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from '../common/cache/redis.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../common/prisma/prisma.module';
import { VirtualReceptionistController } from './virtual-receptionist.controller';
import { VirtualReceptionistService } from './virtual-receptionist.service';
import { LLMService } from './services/llm.service';
import { ConversationService } from './services/conversation.service';
import { FAQService } from './services/faq.service';
import { FAQCacheService } from './services/faq-cache.service';
import { AiConversationCounterService } from './services/ai-conversation-counter.service';
import { BookingService } from './services/booking.service';
import { AnalysisService } from './services/analysis.service';
import { LLMProviderFactory } from './factories/llm-provider.factory';
import { OpenAIProvider } from './providers/openai.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GoogleProvider } from './providers/google.provider';
import { LlamaProvider } from './providers/llama.provider';
import { MiniMaxProvider } from './providers/MiniMax.provider';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConversationMemoryRepository } from './repositories/conversation-memory.repository';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { AiFairUseResetScheduler } from './schedulers/ai-fair-use-reset.scheduler';
import { UpsellModule } from '../upsell/upsell.module';
import { PaymentsModule } from '../payments/payments.module';
import { SalonToolsService } from './tools/salon-tools';
import { AppointmentsModule } from '../appointments/appointments.module';
import { WebChannelProvider } from './channels/web-channel.provider';
import { FacebookMessengerProvider } from './channels/facebook-messenger.provider';
import { InstagramChannelProvider } from './channels/instagram-channel.provider';
import { TelegramChannelProvider } from './channels/telegram-channel.provider';
import { ChannelRegistry } from './channels/channel.registry';
import { ChannelsConfigService } from './services/channels-config.service';
import { ChannelsConfigController } from './controllers/channels-config.controller';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    NotificationsModule,
    ProfessionalsModule,
    UpsellModule,
    PaymentsModule,
    AppointmentsModule,
    PlatformModule,
  ],
  controllers: [VirtualReceptionistController, ChannelsConfigController],
  providers: [
    VirtualReceptionistService,
    LLMService,
    ConversationService,
    FAQService,
    FAQCacheService,
    AiConversationCounterService,
    BookingService,
    AnalysisService,
    LLMProviderFactory,
    OpenAIProvider,
    AnthropicProvider,
    GoogleProvider,
    LlamaProvider,
    MiniMaxProvider,
    ConversationMemoryRepository,
    WebChannelProvider,
    FacebookMessengerProvider,
    InstagramChannelProvider,
    TelegramChannelProvider,
    ChannelRegistry,
    ChannelsConfigService,
    SalonToolsService,
  ],
  exports: [
    VirtualReceptionistService,
    LLMService,
    ConversationService,
    FAQService,
    BookingService,
    AnalysisService,
    ChannelRegistry,
    ChannelsConfigService,
    SalonToolsService,
  ],
})
export class VirtualReceptionistModule {}