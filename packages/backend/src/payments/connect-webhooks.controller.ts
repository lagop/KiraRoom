import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { Public } from '../auth/decorators/public.decorator';
import { PlatformStripeConfigService } from '../platform/platform-stripe-config.service';
import { ConnectEventsService } from './services/connect-events.service';
import { unverifiedLivemode } from './webhooks.controller';

/**
 * Stripe's webhook for the salons' connected accounts ("Cuentas conectadas"),
 * apart from the platform's own at POST /webhooks/stripe: another endpoint in
 * Stripe, another signing secret (one per mode, set in the platform console).
 * Public because Stripe has no session; the signature is what authenticates.
 * Unlike the platform webhook there is no unsigned path: without a secret it
 * answers 503 so Stripe retries once the operator has set it.
 */
@Controller('webhooks')
export class ConnectWebhooksController {
  private readonly logger = new Logger(ConnectWebhooksController.name);

  constructor(
    private readonly platformStripe: PlatformStripeConfigService,
    private readonly events: ConnectEventsService,
  ) {}

  @Post('stripe-connect')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Headers('stripe-signature') signature: string,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody?.toString() || JSON.stringify(body);
    const secrets = this.platformStripe.connectWebhookSecrets(unverifiedLivemode(rawBody, body));
    const stripe = this.platformStripe.client();
    if (secrets.length === 0 || !stripe) {
      this.logger.error('Stripe Connect webhook called but no signing secret is set in the console; refusing.');
      throw new HttpException('Stripe Connect webhook not configured', HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (!signature) throw new BadRequestException('Missing stripe-signature header');

    let event: Stripe.Event | null = null;
    let lastError: Error | null = null;
    for (const secret of secrets) {
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, secret);
        break;
      } catch (err) {
        lastError = err as Error;
      }
    }
    if (!event) {
      this.logger.warn(`Stripe Connect webhook signature verification failed: ${lastError?.message ?? 'no secret'}`);
      throw new BadRequestException('Invalid Stripe signature');
    }
    return this.events.handle(event);
  }
}
