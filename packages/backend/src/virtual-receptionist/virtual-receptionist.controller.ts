import { Throttle } from "@nestjs/throttler";
import { ParseUUIDPipe, Controller, Post, Req, Get, Put, Delete, Body, Param, Query, UseGuards, UsePipes, ValidationPipe, Logger } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { Roles, SALON_MANAGERS, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { VirtualReceptionistService } from './virtual-receptionist.service';
import { ConversationService } from './services/conversation.service';
import { FAQService } from './services/faq.service';
import { BookingService } from './services/booking.service';
import { LLMService } from './services/llm.service';
import {
  SendMessageDto,
  MessageResponseDto,
  CreateConversationDto,
  UpdateConversationDto,
  CreateFAQItem,
  UpdateFAQItem,
  CreateVirtualReceptionistConfig,
  UpdateVirtualReceptionistConfig,
  CreateLLMProviderConfig,
  UpdateLLMProviderConfig,
} from '@kira/shared';
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
    private readonly faqService: FAQService,
    private readonly bookingService: BookingService,
    private readonly llmService: LLMService,
  ) {}

  // Virtual Receptionist Configuration
  @Post('config')
  @ApiOperation({ summary: 'Create virtual receptionist configuration' })
  @Roles(...SALON_MANAGERS)
  async createConfig(@Body(new ValidationPipe()) config: CreateVirtualReceptionistConfig) {
    this.logger.log('Creating virtual receptionist configuration');
    return this.virtualReceptionistService.createConfig(config);
  }

  @Get('config/:salonId')
  @ApiOperation({ summary: 'Get virtual receptionist configuration for salon' })
  @Roles(...SALON_MANAGERS)
  async getConfig(@Param('salonId') salonId: string) {
    this.logger.log(`Getting virtual receptionist configuration for salon: ${salonId}`);
    return this.virtualReceptionistService.getConfig(salonId);
  }

  @Put('config/:salonId')
  @ApiOperation({ summary: 'Update virtual receptionist configuration' })
  @Roles(...SALON_MANAGERS)
  async updateConfig(
    @Param('salonId') salonId: string,
    @Body(new ValidationPipe()) config: UpdateVirtualReceptionistConfig,
  ) {
    this.logger.log(`Updating virtual receptionist configuration for salon: ${salonId}`);
    return this.virtualReceptionistService.updateConfig(salonId, config);
  }

  // LLM Provider Configuration
  @Post('llm-config')
  @ApiOperation({ summary: 'Create LLM provider configuration' })
  @SaasOwner()
  async createLLMConfig(@Body(new ValidationPipe()) config: CreateLLMProviderConfig) {
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
    @Body(new ValidationPipe()) config: UpdateLLMProviderConfig,
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
  async createConversation(@Body(new ValidationPipe()) data: CreateConversationDto) {
    this.logger.log(`Creating new conversation: ${data.clientId} - ${data.salonId}`);
    return this.conversationService.createConversation(data);
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
    @Body(new ValidationPipe()) data: UpdateConversationDto,
  ) {
    this.logger.log(`Updating conversation: ${id}`);
    return this.conversationService.updateConversation(id, data);
  }

  @Delete('conversations/:id')
  @ApiOperation({ summary: 'Delete conversation' })
  @Roles(...SALON_MANAGERS)
  async deleteConversation(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Deleting conversation: ${id}`);
    return this.conversationService.deleteConversation(id);
  }

  // Chat Messaging
  @Post('messages')
  @Throttle({ default: { ttl: 60_000, limit: 20 } }) // each message is a paid model call
  @Public()
  @ApiOperation({ summary: 'Send message to virtual receptionist' })
  async sendMessage(@Body(new ValidationPipe()) message: SendMessageDto) {
    this.logger.log(`Processing message from client: ${message.clientId}`);
    return this.virtualReceptionistService.sendMessage(message);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Get conversation messages' })
  @Roles(...SALON_MANAGERS)
  async getConversationMessages(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Getting messages for conversation: ${id}`);
    return this.conversationService.getConversationMessages(id);
  }

  // FAQ Management. Always the caller's own salon: these took no tenant at
  // all, so any signed-in user -- a client of another salon included --
  // could write a FAQ that every salon's receptionist then repeated.
  @Post('faqs')
  @UseGuards(RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: 'Create FAQ item' })
  async createFAQ(@CurrentUser() user: any, @Body(new ValidationPipe()) faq: CreateFAQItem) {
    this.logger.log('Creating FAQ item');
    return this.faqService.createFAQ(user.tenantId, faq);
  }

  @Get('faqs')
  @UseGuards(RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: 'Get FAQ items' })
  async getFAQs(@CurrentUser() user: any) {
    return this.faqService.getFAQs(user.tenantId);
  }

  // FAQ ids are not UUIDs (see FAQService.generateId), so no ParseUUIDPipe:
  // it rejected every one of them.
  @Get('faqs/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: 'Get FAQ item' })
  async getFAQ(@CurrentUser() user: any, @Param('id') id: string) {
    return this.faqService.getFAQ(user.tenantId, id);
  }

  @Put('faqs/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: 'Update FAQ item' })
  async updateFAQ(@CurrentUser() user: any, @Param('id') id: string, @Body(new ValidationPipe()) faq: UpdateFAQItem) {
    this.logger.log(`Updating FAQ item: ${id}`);
    return this.faqService.updateFAQ(user.tenantId, id, faq);
  }

  @Delete('faqs/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: 'Delete FAQ item' })
  async deleteFAQ(@CurrentUser() user: any, @Param('id') id: string) {
    this.logger.log(`Deleting FAQ item: ${id}`);
    return this.faqService.deleteFAQ(user.tenantId, id);
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
  async testLLMProvider(@Body() data: { provider: string; apiKey: string; model?: string }) {
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

  // Statistics and Analytics
  @Get('stats')
  @ApiOperation({ summary: 'Get virtual receptionist statistics' })
  @Roles(...SALON_MANAGERS)
  async getStatistics() {
    this.logger.log('Getting virtual receptionist statistics');
    return this.virtualReceptionistService.getStatistics();
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