import {
  Controller,
  Post,
  Headers,
  RawBodyRequest,
  Req,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../auth/decorators/public.decorator";
import { verifySvixSignature } from "../common/webhooks/svix-signature";
import { ResendEventsService, ResendWebhookEvent } from "./resend-events.service";

/**
 * POST /api/v1/webhooks/resend -- Resend's delivery events.
 *
 * Public because Resend has no session; trusted only through the Svix
 * signature over the raw body, with RESEND_WEBHOOK_SECRET (the "whsec_..."
 * signing secret Resend shows for the endpoint). Without that secret nothing
 * is processed: an unsigned webhook that edits campaign numbers and the
 * suppression list would let anyone stop a salon's emails.
 */
@ApiTags("Email Webhooks")
@Controller("webhooks/resend")
export class ResendWebhooksController {
  private readonly logger = new Logger(ResendWebhooksController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly events: ResendEventsService,
  ) {}

  // Not rate limited per address: a campaign's delivered/opened events
  // arrive in bursts from the same few Svix servers, and every request is
  // signature-checked before any work is done.
  @SkipThrottle()
  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Handle Resend webhook events (Svix-signed)" })
  @ApiResponse({ status: 200, description: "Webhook processed" })
  async handleResendWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("svix-id") svixId?: string,
    @Headers("svix-timestamp") svixTimestamp?: string,
    @Headers("svix-signature") svixSignature?: string,
  ) {
    const secret = this.configService.get<string>("RESEND_WEBHOOK_SECRET");
    if (!secret) {
      // 503 so Resend keeps retrying until the operator sets the secret,
      // instead of the events being acknowledged and lost.
      this.logger.error("Resend webhook called but RESEND_WEBHOOK_SECRET is not set; refusing.");
      throw new ServiceUnavailableException("Resend webhook not configured");
    }
    if (!req.rawBody) throw new BadRequestException("Missing body");

    const verdict = verifySvixSignature(
      req.rawBody,
      { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      secret,
    );
    if (!verdict.ok) {
      this.logger.warn(`Rejected Resend webhook: ${verdict.reason}`);
      throw new UnauthorizedException("Invalid Resend signature");
    }

    // Parse what was signed, not what the body parser made of it.
    let event: ResendWebhookEvent;
    try {
      event = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Invalid JSON");
    }

    // Errors propagate as 500: Svix retries, and the handling is idempotent.
    await this.events.handle(event, svixId as string);
    return { received: true };
  }
}
