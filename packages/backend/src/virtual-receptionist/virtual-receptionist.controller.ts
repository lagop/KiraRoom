import { Throttle } from "@nestjs/throttler";
import { ParseUUIDPipe, Controller, Post, Req, Get, Put, Delete, Body, Param, Query, UseGuards, Logger } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { Roles, SALON_MANAGERS, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { VirtualReceptionistService } from './virtual-receptionist.service';
import { ConversationService } from './services/conversation.service';
import { BookingService } from './services/booking.service';
import { LLMService } from './services/llm.service';
import { ReceptionistStatsService } from './services/receptionist-stats.service';
import { PublicChatAccessService } from './public-chat/public-chat-access.service';
import { PublicChatMessageDto } from './public-chat/public-chat-message.dto';
import { publicChatReply } from './public-chat/public-chat-reply';
import { logId } from './log-id';
import { SendMessageDto } from '@kira/shared';
import {
  CreateConversationBodyDto,
  CreateLlmProviderConfigDto,
  TestLlmProviderDto,
  UpdateConversationBodyDto,
  UpdateLlmProviderConfigDto,
} from './dto/receptionist-bodies.dto';
import { FeatureGuard } from '../common/guards/feature.guard';
import { Feature } from '../common/decorators/feature.decorator';
import { SaasOwner } from "../saas/decorators/saas-owner.decorator";

@ApiTags('virtual-receptionist')
@ApiBearerAuth()
@UseGuards(FeatureGuard)
@Feature('virtual_receptionist')
@Controller('virtual-receptionist')
export class VirtualReceptionistController {
  private readonly logger = new Logger(VirtualReceptionistController.name);

  constructor(
    private readonly virtualReceptionistService: VirtualReceptionistService,
    private readonly conversationService: ConversationService,
    private readonly bookingService: BookingService,
    private readonly llmService: LLMService,
    private readonly statsService: ReceptionistStatsService,
    private readonly publicChat: PublicChatAccessService,
  ) {}

  // POST/GET/PUT /virtual-receptionist/config[/:salonId] used to be here.
  // GET answered the same fixed settings for any salon (provider "openai",
  // model "gpt-4", 09:00-18:00 hours, a greeting nobody sent) and POST/PUT
  // echoed the body back without saving it. The receptionist actually runs
  // on the platform's LLM setting (SaaS owner), the salon's own hours,
  // services and FAQs, and the channel switches in
  // /virtual-receptionist/channels/config -- all saved and read for real.

  // LLM Provider Configuration
  @Post('llm-config')
  @ApiOperation({ summary: 'Create LLM provider configuration' })
  @SaasOwner()
  async createLLMConfig(@Body() config: CreateLlmProviderConfigDto) {
    this.logger.log('Creating LLM provider configuration');
    return this.llmService.createProviderConfig(config);
  }

  @Get('llm-config')
  @ApiOperation({ summary: 'Get all LLM provider configurations' })
  @SaasOwner()
  async getLLMConfigs() {
    this.logger.log('Getting all LLM provider configurations');
    return this.llmService.getProviderConfigs();
  }

  @Get('llm-config/:id')
  @ApiOperation({ summary: 'Get LLM provider configuration' })
  @SaasOwner()
  async getLLMConfig(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Getting LLM provider configuration: ${id}`);
    return this.llmService.getProviderConfig(id);
  }

  @Put('llm-config/:id')
  @ApiOperation({ summary: 'Update LLM provider configuration' })
  @SaasOwner()
  async updateLLMConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() config: UpdateLlmProviderConfigDto,
  ) {
    this.logger.log(`Updating LLM provider configuration: ${id}`);
    return this.llmService.updateProviderConfig(id, config);
  }

  @Delete('llm-config/:id')
  @ApiOperation({ summary: 'Delete LLM provider configuration' })
  @SaasOwner()
  async deleteLLMConfig(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Deleting LLM provider configuration: ${id}`);
    return this.llmService.deleteProviderConfig(id);
  }

  // Conversation Management
  @Post('conversations')
  @ApiOperation({ summary: 'Create new conversation' })
  @Roles(...SALON_MANAGERS)
  async createConversation(@CurrentUser() user: any, @Body() data: CreateConversationBodyDto) {
    this.logger.log(`Creating new conversation: ${logId(data.clientId)} - ${user.tenantId}`);
    // The caller's salon: the body used to name salonId and tenantId.
    return this.conversationService.createConversation({
      clientId: data.clientId,
      salonId: user.tenantId,
      tenantId: user.tenantId,
      channel: data.channel,
      metadata: data.metadata,
    });
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get conversation by ID' })
  @Roles(...SALON_MANAGERS)
  async getConversation(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Getting conversation: ${id}`);
    return this.conversationService.getConversation(id);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Get conversations' })
  @Roles(...SALON_MANAGERS)
  async getConversations(@Query('salonId') salonId?: string) {
    this.logger.log(`Getting conversations for salon: ${salonId}`);
    return this.conversationService.getConversations(salonId);
  }

  @Put('conversations/:id')
  @ApiOperation({ summary: 'Update conversation' })
  @Roles(...SALON_MANAGERS)
  async updateConversation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateConversationBodyDto,
  ) {
    this.logger.log(`Updating conversation: ${id}`);
    return this.conversationService.updateConversation(id, {
      ...(data.status !== undefined && { status: data.status }),
      ...(data.handoffUserId !== undefined && { handoffUserId: data.handoffUserId }),
      ...(data.handoffAt !== undefined && { handoffAt: data.handoffAt }),
    });
  }

  @Delete('conversations/:id')
  @ApiOperation({ summary: 'Delete conversation' })
  @Roles(...SALON_MANAGERS)
  async deleteConversation(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Deleting conversation: ${id}`);
    return this.conversationService.deleteConversation(id);
  }

  // Chat Messaging
  /**
   * The chat on a salon's site. Public, because visitors have no account;
   * who is writing is decided here (see PublicChatAccessService), never taken
   * from the body: a signed visitor token this endpoint issued (salon
   * clients have no accounts). Then a daily limit per person and one per
   * address, on top of the per-minute limit, before the paid model call.
   *
   * The answer carries only what the widget shows. It used to be the whole
   * internal result: every tool call with its input and output (service and
   * professional ids, raw exception text), the model, the intent and, with
   * the cap reached, the salon's AI usage -- to any visitor.
   */
  @Post('messages')
  @Throttle({ default: { ttl: 60_000, limit: 20 } }) // each message is a paid model call
  @Public()
  @ApiOperation({ summary: 'Send message to virtual receptionist' })
  async sendMessage(@Body() body: PublicChatMessageDto, @Req() req?: { ip?: string; socket?: { remoteAddress?: string } }) {
    const identity = this.publicChat.identify(body);
    // The address the rate limiter counts (ThrottlerBehindProxyGuard).
    const ip = req?.ip ?? req?.socket?.remoteAddress ?? undefined;
    await this.publicChat.assertWithinDailyLimit(identity, body.salonId, new Date(), ip);
    this.logger.log(`Processing web message from ${logId(identity.clientId)}`);
    const reply = await this.virtualReceptionistService.sendMessage({
      clientId: identity.clientId,
      salonId: body.salonId,
      message: body.message,
      channel: 'web',
      // A visitor's name is whatever they type in the chat, not a field.
      metadata: { serviceId: body.metadata?.serviceId },
    } as SendMessageDto);
    return publicChatReply(reply, identity.visitorToken);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Get conversation messages' })
  @Roles(...SALON_MANAGERS)
  async getConversationMessages(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Getting messages for conversation: ${id}`);
    return this.conversationService.getConversationMessages(id);
  }

  // Booking Management
  //
  // POST /virtual-receptionist/booking used to be here: it invented an id
  // and answered "¡Cita reservada con éxito!" without creating anything.
  // Nothing called it. Bookings go through POST /appointments.

  @Get('booking/availability')
  @ApiOperation({ summary: 'Check appointment availability' })
  @Roles(...SALON_TEAM)
  async checkAvailability(@Query() query: any) {
    this.logger.log('Checking appointment availability');
    return this.bookingService.checkAvailability(query);
  }

  // LLM Provider Management
  @Post('llm/test')
  @ApiOperation({ summary: 'Test LLM provider connection' })
  @SaasOwner()
  async testLLMProvider(@Body() data: TestLlmProviderDto) {
    this.logger.log(`Testing LLM provider: ${data.provider}`);
    return this.llmService.testProvider(data);
  }

  @Get('llm/models')
  @ApiOperation({ summary: 'Get available LLM models' })
  @SaasOwner()
  async getAvailableModels() {
    this.logger.log('Getting available LLM models');
    return this.llmService.getAvailableModels();
  }

  // POST /virtual-receptionist/whatsapp/webhook used to be here: public,
  // with no Twilio signature check, it answered "You said: ..." to any
  // number -- once Twilio is configured, anyone could have sent WhatsApp
  // messages paid by KiraRoom. Inbound WhatsApp arrives through
  // /webhooks/meta/whatsapp, which verifies the signature.

  // Statistics: the caller's salon only, from its own conversations.
  @Get('stats')
  @ApiOperation({ summary: 'Get virtual receptionist statistics for the last N days' })
  @Roles(...SALON_MANAGERS)
  async getStatistics(@Req() req: any, @Query('days') days?: string) {
    return this.statsService.forTenant(req.user.tenantId, days ? Number(days) : 30);
  }

  // P2A-receptionist-v2 -- AI usage counter for the billing dashboard.
  // Surfaces the current month's count, the cap (null = unlimited),
  // and the next reset date so the UI can show a "X/500 conversations"
  // progress bar.
  @Get('ai-usage')
  @ApiOperation({ summary: 'Get current AI conversation usage for this month' })
  @Roles(...SALON_MANAGERS)
  async getAiUsage(@Req() req: any) {
    const tenantId = req?.user?.tenantId;
    if (!tenantId) {
      return { used: 0, cap: null, resetsAt: null };
    }
    const cap = await this.virtualReceptionistService.resolveEffectiveCap(tenantId);
    const used = await this.virtualReceptionistService.getCurrentAiCount(tenantId);
    const resetsAt = await this.virtualReceptionistService.getAiResetAt(tenantId);
    return { used, cap, resetsAt };
  }
}