import { Controller, Post, Body, Headers, RawBodyRequest, Req, HttpCode, HttpStatus, Logger, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';

interface ResendWebhookEvent {
  type: 'email.sent' | 'email.delivered' | 'email.opened' | 'email.clicked' | 'email.bounced' | 'email.unsubscribed';
  data: {
    id: string;
    from: string;
    to: string;
    subject: string;
    created_at: string;
  };
}

@ApiTags('Email Webhooks')
@Controller('webhooks/resend')
export class ResendWebhooksController {
  private readonly logger = new Logger(ResendWebhooksController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle Resend webhook events' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  async handleResendWebhook(
    @Body() body: ResendWebhookEvent,
    @Headers('resend-webhook-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    this.logger.log(`Received Resend webhook: ${body.type}`);

    try {
      // Verify webhook signature (in production, implement proper verification)
      const webhookSecret = this.configService.get<string>('RESEND_WEBHOOK_SECRET');
      
      // For now, we'll process the webhook without signature verification
      // In production, you should verify the signature using:
      // const signature = req.headers['resend-webhook-signature'];
      // const expectedSignature = crypto.createHmac('sha256', webhookSecret)
      //   .update(req.rawBody)
      //   .digest('hex');
      
      const { type, data } = body;
      
      // Extract message ID from Resend's data
      const messageId = data.id;
      
      // Find the recipient by message ID
      // The messageId format in our system is: campaign_{campaignId}_{recipientId}
      if (messageId && messageId.startsWith('campaign_')) {
        const parts = messageId.split('_');
        if (parts.length >= 3) {
          const campaignId = parts[1];
          const recipientId = parts.slice(2).join('_');
          
          await this.processWebhookEvent(type, campaignId, recipientId, data);
        }
      }

      return { received: true };
    } catch (error) {
      this.logger.error(`Error processing Resend webhook: ${error.message}`);
      // Return 200 to acknowledge receipt even if processing fails
      return { received: true };
    }
  }

  private async processWebhookEvent(
    type: string,
    campaignId: string,
    recipientId: string,
    data: any,
  ) {
    const now = new Date();

    switch (type) {
      case 'email.sent':
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'sent',
            sentAt: now } });
        
        // Update campaign stats
        await this.prisma.emailCampaign.update({
          where: { id: campaignId },
          data: {
            emailsSent: { increment: 1 } } });
        break;

      case 'email.delivered':
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'delivered',
            deliveredAt: now } });
        
        await this.prisma.emailCampaign.update({
          where: { id: campaignId },
          data: {
            emailsDelivered: { increment: 1 } } });
        break;

      case 'email.opened':
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'opened',
            openedAt: now } });
        
        await this.prisma.emailCampaign.update({
          where: { id: campaignId },
          data: {
            emailsOpened: { increment: 1 } } });
        
        // Log analytics
        await this.prisma.emailCampaignAnalytics.create({
          data: {
            campaignId,
            eventType: 'opened',
            timestamp: now,
            email: data.to,
            messageId: data.id } });
        break;

      case 'email.clicked':
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'clicked',
            clickedAt: now } });
        
        await this.prisma.emailCampaign.update({
          where: { id: campaignId },
          data: {
            clicks: { increment: 1 } } });
        
        await this.prisma.emailCampaignAnalytics.create({
          data: {
            campaignId,
            eventType: 'clicked',
            timestamp: now,
            email: data.to,
            messageId: data.id,
            url: data.url, // If provided by Resend
          } });
        break;

      case 'email.bounced':
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'bounced',
            bouncedAt: now,
            errorMessage: data.bounce_reason || 'Bounced' } });
        
        await this.prisma.emailCampaign.update({
          where: { id: campaignId },
          data: {
            bounces: { increment: 1 } } });
        
        await this.prisma.emailCampaignAnalytics.create({
          data: {
            campaignId,
            eventType: 'bounced',
            timestamp: now,
            email: data.to,
            messageId: data.id } });
        break;

      case 'email.unsubscribed':
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'unsubscribed',
            unsubscribedAt: now } });
        
        await this.prisma.emailCampaign.update({
          where: { id: campaignId },
          data: {
            unsubscribes: { increment: 1 } } });
        
        await this.prisma.emailCampaignAnalytics.create({
          data: {
            campaignId,
            eventType: 'unsubscribed',
            timestamp: now,
            email: data.to,
            messageId: data.id } });
        break;
    }

    this.logger.log(`Processed webhook event: ${type} for recipient ${recipientId}`);
  }
}
