import { Throttle } from "@nestjs/throttler";
import { ParseUUIDPipe, Controller, Post, Req, Get, Put, Delete, Body, Param, Query, UseGuards, Logger, ForbiddenException } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { Roles, SALON_MANAGERS, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { VirtualReceptionistService } from './virtual-receptionist.service';
import { BookingService } from './services/booking.service';
import { LLMService } from './services/llm.service';
import { ReceptionistStatsService } from './services/receptionist-stats.service';
import { PublicChatAccessService } from './public-chat/public-chat-access.service';
import { PublicChatMessageDto } from './public-chat/public-chat-message.dto';
import { publicChatReply } from './public-chat/public-chat-reply';
import { logId } from './log-id';
import { InboxView, ReceptionistInboxService } from './inbox/receptionist-inbox.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SendMessageDto } from '@kira/shared';
import {
  TestLlmProviderDto,
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
    private readonly bookingService: BookingService,
    private readonly llmService: LLMService,
    private readonly statsService: ReceptionistStatsService,
    private readonly publicChat: PublicChatAccessService,
    private readonly inbox: ReceptionistInboxService,
    private readonly prisma: PrismaService,
  ) {}

  // POST/GET/PUT /virtual-receptionist/config[/:salonId] used to be here.
  // GET answered the same fixed settings for any salon (provider "openai",
  // model "gpt-4", 09:00-18:00 hours, a greeting nobody sent) and POST/PUT
  // echoed the body back without saving it. The receptionist actually runs
  // on the platform's LLM setting (SaaS owner), the salon's own hours,
  // services and FAQs, and the channel switches in
  // /virtual-receptionist/channels/config -- all saved and read for real.

  // /virtual-receptionist/llm-config[/:id] (create, list, read, update,
  // delete) used to be here (audit 8, C16): they answered an invented
  // OpenAI/Anthropic/Google list and "saved" without saving anything. The
  // platform's real LLM setting is /platform/llm-config.

  // Conversation management. The routes here took a conversation id (or a
  // salonId in the query) and never checked it against the caller's salon:
  // a manager of any salon could read, change or close another salon's
  // conversations. Nothing in the panel called them. The panel's
  // Conversaciones uses the inbox routes below, always the caller's salon.

  /** Conversaciones: every channel, newest first; read-only. */
  @Get('inbox')
  @ApiOperation({ summary: "The salon's receptionist conversations" })
  @Roles(...SALON_MANAGERS)
  async listInbox(
    @CurrentUser() user: any,
    @Query('view') view?: string,
    @Query('channel') channel?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
  ) {
    const v: InboxView = view === 'attention' || view === 'paused' ? view : 'all';
    return this.inbox.list(user.tenantId, { view: v, channel, q, page: Number(page) || 1 });
  }

  @Get('inbox/attention-count')
  @ApiOperation({ summary: 'Conversations waiting for the salon' })
  @Roles(...SALON_MANAGERS)
  async inboxAttentionCount(@CurrentUser() user: any) {
    return { count: await this.inbox.attentionCount(user.tenantId) };
  }

  @Get('inbox/:id')
  @ApiOperation({ summary: 'One conversation with its messages' })
  @Roles(...SALON_MANAGERS)
  async getInboxConversation(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.inbox.get(user.tenantId, id);
  }

  /** The assistant stops answering in this conversation, on every channel. */
  @Post('inbox/:id/pause')
  @ApiOperation({ summary: 'Pause the assistant in a conversation' })
  @Roles(...SALON_MANAGERS)
  async pauseConversation(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.inbox.pause({ id: user.id, role: user.role, tenantId: user.tenantId }, id);
  }

  @Post('inbox/:id/resume')
  @ApiOperation({ summary: 'Resume the assistant in a conversation' })
  @Roles(...SALON_MANAGERS)
  async resumeConversation(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.inbox.resume({ id: user.id, role: user.role, tenantId: user.tenantId }, id);
  }

  @Post('inbox/:id/attended')
  @ApiOperation({ summary: 'Mark a conversation the salon was told about as attended' })
  @Roles(...SALON_MANAGERS)
  async markConversationAttended(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.inbox.markAttended({ id: user.id, role: user.role, tenantId: user.tenantId }, id);
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
    // Ajustes > Recepcionista "Chat en mi web" off: the page shows no chat,
    // and a page loaded before the change, or a script, is refused here.
    const salon = await this.prisma.tenant.findUnique({ where: { id: body.salonId }, select: { webChatEnabled: true } });
    if (salon && salon.webChatEnabled === false) {
      throw new ForbiddenException('El chat de este salón no está disponible.');
    }
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
      metadata: {
        serviceId: body.metadata?.serviceId,
        ...(body.metadata?.newConversation ? { newConversation: true } : {}),
      },
    } as SendMessageDto);
    return publicChatReply(reply, identity.visitorToken);
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