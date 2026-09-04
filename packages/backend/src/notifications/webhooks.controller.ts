import { Controller, Post, Body, Headers, Logger, HttpStatus, HttpCode, Req } from "@nestjs/common";
import { Request } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import * as crypto from 'crypto';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private prisma: PrismaService) {}

  // Resend webhook for email delivery tracking
  @Public()
  @Post('email/resend')
  @HttpCode(HttpStatus.OK)
  async handleResendWebhook(
    @Body() body: any,
    @Headers('sv-signature') signature: string,
    @Req() req: Request,
  ) {
    this.logger.log('Received Resend webhook');
    
    try {
      // Verify signature if secret is configured
      const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
      if (webhookSecret && signature) {
        const rawBody = JSON.stringify(body);
        if (!this.verifyResendSignature(rawBody, signature, webhookSecret)) {
          this.logger.warn('Invalid Resend webhook signature');
          return { received: false, error: 'Invalid signature' };
        }
      }
      
      // Resend webhook events: email_sent, email_delivered, email_opened, email_bounced, email_clicked
      const { type, data } = body;
      
      switch (type) {
        case 'email_sent':
          await this.handleEmailSent(data);
          break;
        case 'email_delivered':
          await this.handleEmailDelivered(data);
          break;
        case 'email_opened':
          await this.handleEmailOpened(data);
          break;
        case 'email_bounced':
          await this.handleEmailBounced(data);
          break;
        case 'email_clicked':
          await this.handleEmailClicked(data);
          break;
        default:
          this.logger.warn(`Unknown Resend event type: ${type}`);
      }
      
      return { received: true };
    } catch (error) {
      this.logger.error('Error processing Resend webhook', error);
      return { received: true }; // Always return 200 to prevent retries
    }
  }

  // Twilio webhook for SMS delivery tracking
  @Public()
  @Post('sms/twilio')
  @HttpCode(HttpStatus.OK)
  async handleTwilioWebhook(@Body() body: any) {
    this.logger.log('Received Twilio webhook');
    
    try {
      const { MessageSid, MessageStatus, To, ErrorCode, ErrorMessage } = body;
      
      await this.prisma.notificationDelivery.upsert({
        where: { externalId: MessageSid },
        create: {
          externalId: MessageSid,
          channel: 'SMS',
          status: this.mapTwilioStatus(MessageStatus),
          recipient: To,
          deliveredAt: MessageStatus === 'delivered' ? new Date() : null,
          failedAt: MessageStatus === 'failed' || MessageStatus === 'undelivered' ? new Date() : null,
          failureReason: ErrorMessage || ErrorCode?.toString() || null },
        update: {
          status: this.mapTwilioStatus(MessageStatus),
          deliveredAt: MessageStatus === 'delivered' ? new Date() : null,
          failedAt: MessageStatus === 'failed' || MessageStatus === 'undelivered' ? new Date() : null,
          failureReason: ErrorMessage || ErrorCode?.toString() || null } });
      
      return { received: true };
    } catch (error) {
      this.logger.error('Error processing Twilio webhook', error);
      return { received: true };
    }
  }

  private async handleEmailSent(data: any) {
    const { email_id, to } = data;
    this.logger.log(`Email sent to ${to}, ID: ${email_id}`);
    
    await this.updateDeliveryStatus(email_id, 'SENT', 'EMAIL', to);
  }

  private async handleEmailDelivered(data: any) {
    const { email_id, to } = data;
    this.logger.log(`Email delivered to ${to}`);
    
    await this.updateDeliveryStatus(email_id, 'DELIVERED', 'EMAIL', to, new Date());
  }

  private async handleEmailOpened(data: any) {
    const { email_id, to } = data;
    this.logger.log(`Email opened by ${to}`);
    
    await this.updateDeliveryStatus(email_id, 'OPENED', 'EMAIL', to);
  }

  private async handleEmailBounced(data: any) {
    const { email_id, to, bounce_type, bounce_message } = data;
    this.logger.warn(`Email bounced for ${to}: ${bounce_message}`);
    
    await this.updateDeliveryStatus(email_id, 'BOUNCED', 'EMAIL', to, null, new Date(), bounce_message);

    // Stamp the recipient User so future transactional sends skip
    // (EmailService.shouldSkipBouncedUser). Done best-effort — a
    // missing User (e.g. marketing-site visitor who never signed up)
    // is not an error, just a no-op.
    if (to) {
      try {
        const recipient = Array.isArray(to) ? to[0] : to;
        const stamp = await this.prisma.user.updateMany({
          where: { email: String(recipient).toLowerCase() },
          data: {
            emailBouncedAt: new Date(),
            emailBounceReason: bounce_message || bounce_type || "unknown" } });
        if (stamp.count > 0) {
          this.logger.log(
            `Marked ${stamp.count} User(s) with emailBouncedAt for ${recipient}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Failed to stamp User.emailBouncedAt for ${to}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async handleEmailClicked(data: any) {
    const { email_id, to, link } = data;
    this.logger.log(`Email link clicked by ${to}: ${link}`);
    
    // Could track click events separately if needed
  }

  private async updateDeliveryStatus(
    externalId: string,
    status: string,
    channel: string,
    recipient: string,
    deliveredAt?: Date,
    failedAt?: Date,
    failureReason?: string,
  ) {
    try {
      await this.prisma.notificationDelivery.upsert({
        where: { externalId },
        create: {
          externalId,
          channel,
          status,
          recipient,
          deliveredAt,
          failedAt,
          failureReason },
        update: {
          status,
          deliveredAt,
          failedAt,
          failureReason } });
    } catch (error) {
      this.logger.error(`Failed to update delivery status for ${externalId}`, error);
    }
  }

  private mapTwilioStatus(status: string): string {
    const statusMap: Record<string, string> = {
      'queued': 'QUEUED',
      'sent': 'SENT',
      'delivered': 'DELIVERED',
      'undelivered': 'FAILED',
      'failed': 'FAILED',
      'accepted': 'ACCEPTED',
      'scheduled': 'SCHEDULED',
      'canceled': 'CANCELLED' };
    return statusMap[status] || status.toUpperCase();
  }

  private verifyResendSignature(payload: string, signature: string, secret: string): boolean {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64');
      
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch (error) {
      this.logger.error('Error verifying Resend signature', error);
      return false;
    }
  }
}
