import {
  Controller,
  Post,
  Body,
  Headers,
  Logger,
  HttpStatus,
  HttpCode,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { PrismaService } from "../common/prisma/prisma.service";
import { Public } from "../auth/decorators/public.decorator";
import { isValidTwilioRequest } from "./twilio-signature";

/**
 * Delivery callbacks from Twilio.
 *
 * Resend's events used to arrive here too (POST /webhooks/email/resend),
 * with a "signature check" that skipped itself when the header was missing
 * and event names Resend never sends (`email_sent` instead of `email.sent`),
 * so it accepted anything and recorded nothing. They now go to
 * POST /webhooks/resend (email-campaigns/resend-webhooks.controller.ts),
 * which verifies the Svix signature.
 */
@Controller("webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Twilio SMS status callback. Public (Twilio has no session) and trusted
   * only through X-Twilio-Signature: without it anyone could mark any
   * message delivered or failed.
   */
  @Public()
  @Post("sms/twilio")
  @HttpCode(HttpStatus.OK)
  async handleTwilioWebhook(
    @Body() body: any,
    @Headers("x-twilio-signature") signature: string | undefined,
    @Req() req: Request,
  ) {
    const authToken = this.config.get<string>("TWILIO_AUTH_TOKEN");
    if (!authToken) {
      this.logger.error("Twilio webhook called but TWILIO_AUTH_TOKEN is not set; refusing.");
      throw new ServiceUnavailableException("Twilio webhook not configured");
    }
    if (!isValidTwilioRequest(req, signature, authToken, this.config.get<string>("API_BASE_URL"))) {
      this.logger.warn("Rejected Twilio webhook: missing or invalid X-Twilio-Signature");
      throw new UnauthorizedException("Invalid Twilio signature");
    }

    try {
      const { MessageSid, MessageStatus, To, ErrorCode, ErrorMessage } = body ?? {};
      if (!MessageSid || !MessageStatus) return { received: true };

      await this.prisma.notificationDelivery.upsert({
        where: { externalId: MessageSid },
        create: {
          externalId: MessageSid,
          channel: "SMS",
          status: this.mapTwilioStatus(MessageStatus),
          recipient: To,
          deliveredAt: MessageStatus === "delivered" ? new Date() : null,
          failedAt: MessageStatus === "failed" || MessageStatus === "undelivered" ? new Date() : null,
          failureReason: ErrorMessage || ErrorCode?.toString() || null,
        },
        update: {
          status: this.mapTwilioStatus(MessageStatus),
          deliveredAt: MessageStatus === "delivered" ? new Date() : null,
          failedAt: MessageStatus === "failed" || MessageStatus === "undelivered" ? new Date() : null,
          failureReason: ErrorMessage || ErrorCode?.toString() || null,
        },
      });

      return { received: true };
    } catch (error) {
      this.logger.error("Error processing Twilio webhook", error);
      return { received: true };
    }
  }

  private mapTwilioStatus(status: string): string {
    const statusMap: Record<string, string> = {
      queued: "QUEUED",
      sent: "SENT",
      delivered: "DELIVERED",
      undelivered: "FAILED",
      failed: "FAILED",
      accepted: "ACCEPTED",
      scheduled: "SCHEDULED",
      canceled: "CANCELLED",
    };
    return statusMap[status] || String(status).toUpperCase();
  }
}
