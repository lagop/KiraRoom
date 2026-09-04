import {
  Controller,
  Post,
  Req,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { VirtualReceptionistService } from './virtual-receptionist.service';
import { ConversationService } from './services/conversation.service';
import { FAQService } from './services/faq.service';
import { BookingService } from './services/booking.service';
import { LLMService } from './services/llm.service';
import { WhatsAppService, TwilioWhatsAppWebhookEvent } from '../notifications/services/whatsapp.service';
import {
  SendMessageDto,
  MessageResponseDto,
  CreateConversationDto,
  UpdateConversationDto,
  CreateFAQItem,
  UpdateFAQItem,
  BookingRequest,
  CreateVirtualReceptionistConfig,
  UpdateVirtualReceptionistConfig,
  CreateLLMProviderConfig,
  UpdateLLMProviderConfig,
} from '@kira/shared';
import { FeatureGuard } from '../common/guards/feature.guard';
import { Feature } from '../common/decorators/feature.decorator';

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
    private readonly whatsAppService: WhatsAppService,
  ) {}

  // Virtual Receptionist Configuration
  @Post('config')
  @ApiOperation({ summary: 'Create virtual receptionist configuration' })
  async createConfig(@Body(new ValidationPipe()) config: CreateVirtualReceptionistConfig) {
    this.logger.log('Creating virtual receptionist configuration');
    return this.virtualReceptionistService.createConfig(config);
  }

  @Get('config/:salonId')
  @ApiOperation({ summary: 'Get virtual receptionist configuration for salon' })
  async getConfig(@Param('salonId') salonId: string) {
    this.logger.log(`Getting virtual receptionist configuration for salon: ${salonId}`);
    return this.virtualReceptionistService.getConfig(salonId);
  }

  @Put('config/:salonId')
  @ApiOperation({ summary: 'Update virtual receptionist configuration' })
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
  async createLLMConfig(@Body(new ValidationPipe()) config: CreateLLMProviderConfig) {
    this.logger.log('Creating LLM provider configuration');
    return this.llmService.createProviderConfig(config);
  }

  @Get('llm-config')
  @ApiOperation({ summary: 'Get all LLM provider configurations' })
  async getLLMConfigs() {
    this.logger.log('Getting all LLM provider configurations');
    return this.llmService.getProviderConfigs();
  }

  @Get('llm-config/:id')
  @ApiOperation({ summary: 'Get LLM provider configuration' })
  async getLLMConfig(@Param('id') id: string) {
    this.logger.log(`Getting LLM provider configuration: ${id}`);
    return this.llmService.getProviderConfig(id);
  }

  @Put('llm-config/:id')
  @ApiOperation({ summary: 'Update LLM provider configuration' })
  async updateLLMConfig(
    @Param('id') id: string,
    @Body(new ValidationPipe()) config: UpdateLLMProviderConfig,
  ) {
    this.logger.log(`Updating LLM provider configuration: ${id}`);
    return this.llmService.updateProviderConfig(id, config);
  }

  @Delete('llm-config/:id')
  @ApiOperation({ summary: 'Delete LLM provider configuration' })
  async deleteLLMConfig(@Param('id') id: string) {
    this.logger.log(`Deleting LLM provider configuration: ${id}`);
    return this.llmService.deleteProviderConfig(id);
  }

  // Conversation Management
  @Post('conversations')
  @ApiOperation({ summary: 'Create new conversation' })
  async createConversation(@Body(new ValidationPipe()) data: CreateConversationDto) {
    this.logger.log(`Creating new conversation: ${data.clientId} - ${data.salonId}`);
    return this.conversationService.createConversation(data);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get conversation by ID' })
  async getConversation(@Param('id') id: string) {
    this.logger.log(`Getting conversation: ${id}`);
    return this.conversationService.getConversation(id);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Get conversations' })
  async getConversations(@Query('salonId') salonId?: string) {
    this.logger.log(`Getting conversations for salon: ${salonId}`);
    return this.conversationService.getConversations(salonId);
  }

  @Put('conversations/:id')
  @ApiOperation({ summary: 'Update conversation' })
  async updateConversation(
    @Param('id') id: string,
    @Body(new ValidationPipe()) data: UpdateConversationDto,
  ) {
    this.logger.log(`Updating conversation: ${id}`);
    return this.conversationService.updateConversation(id, data);
  }

  @Delete('conversations/:id')
  @ApiOperation({ summary: 'Delete conversation' })
  async deleteConversation(@Param('id') id: string) {
    this.logger.log(`Deleting conversation: ${id}`);
    return this.conversationService.deleteConversation(id);
  }

  // Chat Messaging
  @Post('messages')
  @Public()
  @ApiOperation({ summary: 'Send message to virtual receptionist' })
  async sendMessage(@Body(new ValidationPipe()) message: SendMessageDto) {
    this.logger.log(`Processing message from client: ${message.clientId}`);
    return this.virtualReceptionistService.sendMessage(message);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Get conversation messages' })
  async getConversationMessages(@Param('id') id: string) {
    this.logger.log(`Getting messages for conversation: ${id}`);
    return this.conversationService.getConversationMessages(id);
  }

  // FAQ Management
  @Post('faqs')
  @ApiOperation({ summary: 'Create FAQ item' })
  async createFAQ(@Body(new ValidationPipe()) faq: CreateFAQItem) {
    this.logger.log('Creating FAQ item');
    return this.faqService.createFAQ(faq);
  }

  @Get('faqs')
  @ApiOperation({ summary: 'Get FAQ items' })
  async getFAQs(@Query('salonId') salonId?: string) {
    this.logger.log(`Getting FAQ items for salon: ${salonId}`);
    return this.faqService.getFAQs(salonId);
  }

  @Get('faqs/:id')
  @ApiOperation({ summary: 'Get FAQ item' })
  async getFAQ(@Param('id') id: string) {
    this.logger.log(`Getting FAQ item: ${id}`);
    return this.faqService.getFAQ(id);
  }

  @Put('faqs/:id')
  @ApiOperation({ summary: 'Update FAQ item' })
  async updateFAQ(@Param('id') id: string, @Body(new ValidationPipe()) faq: UpdateFAQItem) {
    this.logger.log(`Updating FAQ item: ${id}`);
    return this.faqService.updateFAQ(id, faq);
  }

  @Delete('faqs/:id')
  @ApiOperation({ summary: 'Delete FAQ item' })
  async deleteFAQ(@Param('id') id: string) {
    this.logger.log(`Deleting FAQ item: ${id}`);
    return this.faqService.deleteFAQ(id);
  }

  // Booking Management
  @Post('booking')
  @ApiOperation({ summary: 'Process booking request' })
  async processBooking(@Body(new ValidationPipe()) request: BookingRequest) {
    this.logger.log('Processing booking request');
    return this.bookingService.processBooking(request);
  }

  @Get('booking/availability')
  @ApiOperation({ summary: 'Check appointment availability' })
  async checkAvailability(@Query() query: any) {
    this.logger.log('Checking appointment availability');
    return this.bookingService.checkAvailability(query);
  }

  // LLM Provider Management
  @Post('llm/test')
  @ApiOperation({ summary: 'Test LLM provider connection' })
  async testLLMProvider(@Body() data: { provider: string; apiKey: string; model?: string }) {
    this.logger.log(`Testing LLM provider: ${data.provider}`);
    return this.llmService.testProvider(data);
  }

  @Get('llm/models')
  @ApiOperation({ summary: 'Get available LLM models' })
  async getAvailableModels() {
    this.logger.log('Getting available LLM models');
    return this.llmService.getAvailableModels();
  }

  // WhatsApp Webhook
  @Post('whatsapp/webhook')
  @Public()
  @ApiOperation({ summary: 'Handle incoming WhatsApp messages' })
  async handleWhatsAppWebhook(@Body() payload: any) {
    this.logger.log('Received WhatsApp webhook event');
    
    try {
      // Process incoming WhatsApp message
      await this.whatsAppService.handleIncomingMessage(payload);
      
      // Extract message details from Twilio webhook
      const from = payload.From;
      const body = payload.Body;
      
      if (!from || !body) {
        this.logger.warn('Invalid WhatsApp webhook payload - missing from or body');
        return { success: false, error: 'Invalid payload' };
      }
      
      // For now, we'll just echo the message back as a placeholder
      // In a real implementation, you would process this through the virtual receptionist
      await this.whatsAppService.sendTextMessage(from, `You said: ${body}`);
      
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to handle WhatsApp webhook: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  // Statistics and Analytics
  @Get('stats')
  @ApiOperation({ summary: 'Get virtual receptionist statistics' })
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