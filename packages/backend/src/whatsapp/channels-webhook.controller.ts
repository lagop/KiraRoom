import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { ConfigService } from '@nestjs/config';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { MetricsService, COUNTERS } from '../common/observability/metrics.service';
import { ChannelCredentialsService } from '../virtual-receptionist/channels/channel-credentials.service';
import {
  ChannelReceptionistService,
  InboundChatMessage,
} from '../virtual-receptionist/channels/channel-receptionist.service';
import { timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

/**
 * Public webhooks for the receptionist's chat channels.
 *
 *  GET/POST /channels/webhooks/meta — Messenger (`object: 'page'`) and
 *    Instagram Direct (`object: 'instagram'`) for every salon. Configured
 *    once in KiraRoom's Meta app; each salon's Page is subscribed to it when
 *    the salon connects. Every delivery carries X-Hub-Signature-256, the
 *    HMAC-SHA256 of the raw body with the app secret.
 *
 *  POST /channels/webhooks/telegram/:tenantId — the salon's own bot. The URL
 *    and a secret_token are registered with setWebhook when the salon
 *    connects; Telegram sends the secret back in
 *    X-Telegram-Bot-Api-Secret-Token.
 *
 * Messages used to be written to the log and nothing else. They now go to
 * ChannelReceptionistService, which answers through the same channel. The
 * handlers return at once: Meta wants its 200 within 5 seconds.
 */
@ApiTags('channels-webhooks')
@Controller('channels/webhooks')
export class ChannelsWebhookController {
  private readonly logger = new Logger(ChannelsWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly whatsapp: WhatsAppService,
    private readonly credentials: ChannelCredentialsService,
    private readonly receptionist: ChannelReceptionistService,
    private readonly featureFlags: FeatureFlagService,
    private readonly metrics: MetricsService,
  ) {}

  /** Meta's verification request when the callback URL is configured in the app. */
  @Get('meta')
  @Public()
  verifyMeta(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const value = this.whatsapp.verifyChallenge(mode, token, challenge);
    if (value === null || !this.config.get<string>('META_WEBHOOK_VERIFY_TOKEN')) {
      return res.status(HttpStatus.FORBIDDEN).send('Forbidden');
    }
    return res.status(HttpStatus.OK).send(value);
  }

  /**
   * Meta webhook (Messenger + Instagram DMs).
   *
   * For Messenger `entry[].id` is the Page id; for Instagram it is the
   * Instagram professional account id. Either one identifies the salon.
   */
  @Post('meta')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 1000, limit: 50 } })
  async handleMeta(
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Signature verification against the raw body. This used to check only
    // that the header existed, so anyone who knew a pageId could inject
    // messages into a salon's receptionist.
    const sig = (req.headers as any)['x-hub-signature-256'] as string | undefined;
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const appSecret = this.config.get<string>('META_APP_SECRET');

    if (!appSecret) {
      // Without a secret no payload can be authenticated. Refuse in
      // production rather than accepting forged traffic; in dev this
      // lets the ngrok quickstart run before the app is configured.
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(
          'Meta webhook rejected: META_APP_SECRET is not configured, signatures cannot be verified.',
        );
        throw new UnauthorizedException('Webhook signature not verifiable');
      }
      this.logger.warn(
        'Meta webhook: META_APP_SECRET unset, skipping signature check (non-production only).',
      );
    } else {
      const payload = rawBody?.toString('utf8') ?? JSON.stringify(body ?? {});
      if (!this.whatsapp.verifyWebhook(payload, sig)) {
        this.metrics
          .counter(COUNTERS.CHANNEL_GATE_BLOCKED, 'Inbound messages dropped by the multichannel gate')
          .inc({ channel: 'meta', reason: 'bad_signature' });
        this.logger.warn('Meta webhook rejected: invalid or missing signature.');
        throw new UnauthorizedException('Invalid signature');
      }
    }

    const platform: 'facebook' | 'instagram' = body?.object === 'instagram' ? 'instagram' : 'facebook';
    if (body?.object !== 'page' && body?.object !== 'instagram') {
      res.json({ received: true });
      return;
    }
    for (const entry of body?.entry ?? []) {
      const accountId: string | undefined = entry?.id ?? entry?.messaging?.[0]?.recipient?.id;
      if (!accountId) continue;
      for (const m of entry?.messaging ?? []) {
        const message = m?.message;
        // Deliveries, reads, reactions and our own replies (echoes) are not
        // messages to answer.
        if (!message || message.is_echo || message.is_deleted || !m?.sender?.id) continue;
        if (m.sender.id === accountId) continue;
        const tenantId =
          platform === 'instagram'
            ? await this.credentials.tenantForInstagram(accountId)
            : await this.credentials.tenantForPage(accountId);
        if (!tenantId) {
          this.logger.warn(`Meta webhook: ${platform} account ${accountId} is not connected to any salon`);
          continue;
        }
        if (!(await this.isMultichannelEnabled(tenantId))) {
          this.logger.warn(
            `Meta webhook: tenant ${tenantId} lacks the 'multichannel' feature; ignoring message from ${m.sender.id}`,
          );
          this.metrics
            .counter(COUNTERS.CHANNEL_GATE_BLOCKED, 'Inbound messages dropped by the multichannel gate')
            .inc({ channel: platform, reason: 'no_feature' });
          continue;
        }
        this.metrics
          .counter(COUNTERS.CHANNEL_INBOUND, 'Inbound messages received per channel')
          .inc({ channel: platform });
        const inbound: InboundChatMessage = {
          channel: platform,
          id: message.mid ?? `${m.sender.id}:${m.timestamp}`,
          from: String(m.sender.id),
          text: typeof message.text === 'string' ? message.text : undefined,
          hasAttachment: Array.isArray(message.attachments) && message.attachments.length > 0,
        };
        // Not awaited: Meta gets its 200 now, the answer follows.
        void this.receptionist.enqueue(tenantId, inbound);
      }
    }
    res.json({ received: true });
  }

  /**
   * Telegram Bot API webhook for one salon's bot. The secret header is
   * compared, in constant time, with the secret registered for that salon.
   *
   * The previous route was shared by every bot and found the salon through
   * a list of "linked chats" that nothing ever filled, so no update was
   * ever accepted.
   */
  @Post('telegram/:tenantId')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 1000, limit: 30 } })
  async handleTelegram(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Headers('x-telegram-bot-api-secret-token') secret: string,
    @Body() body: any,
    @Res() res: Response,
  ): Promise<void> {
    const creds = await this.credentials.telegram(tenantId);
    if (!creds?.webhookSecret) {
      throw new UnauthorizedException('Unknown bot');
    }
    const given = Buffer.from(secret ?? '');
    const want = Buffer.from(creds.webhookSecret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      this.metrics
        .counter(COUNTERS.CHANNEL_GATE_BLOCKED, 'Inbound messages dropped by the multichannel gate')
        .inc({ channel: 'telegram', reason: 'bad_signature' });
      throw new UnauthorizedException('Invalid Telegram secret token');
    }

    const message = body?.message;
    // Only one-to-one chats with a person: the bot is the salon's
    // receptionist, not a group member.
    if (!message?.chat?.id || message.chat.type !== 'private' || message.from?.is_bot) {
      res.json({ received: true });
      return;
    }
    if (!(await this.isMultichannelEnabled(tenantId))) {
      this.logger.warn(
        `Telegram webhook: tenant ${tenantId} lacks the 'multichannel' feature; ignoring message from chat ${message.chat.id}`,
      );
      this.metrics
        .counter(COUNTERS.CHANNEL_GATE_BLOCKED, 'Inbound messages dropped by the multichannel gate')
        .inc({ channel: 'telegram', reason: 'no_feature' });
      res.json({ received: true });
      return;
    }
    this.metrics
      .counter(COUNTERS.CHANNEL_INBOUND, 'Inbound messages received per channel')
      .inc({ channel: 'telegram' });
    const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ').trim();
    void this.receptionist.enqueue(tenantId, {
      channel: 'telegram',
      id: String(body.update_id ?? `${message.chat.id}:${message.message_id}`),
      from: String(message.chat.id),
      text: typeof message.text === 'string' ? message.text : undefined,
      hasAttachment: typeof message.text !== 'string',
      ...(name ? { name } : {}),
    });
    res.json({ received: true });
  }

  /**
   * The `multichannel` feature key, checked here because these
   * server-to-server callbacks have no JWT for the FeatureGuard.
   * Fail-closed: if the entitlement cannot be read, the message is dropped.
   */
  private async isMultichannelEnabled(tenantId: string): Promise<boolean> {
    try {
      return await this.featureFlags.isEnabled(tenantId, 'multichannel');
    } catch (err) {
      this.logger.error(
        `Failed to check multichannel feature for tenant ${tenantId}: ${(err as Error).message}`,
      );
      this.metrics
        .counter(COUNTERS.CHANNEL_GATE_BLOCKED, 'Inbound messages dropped by the multichannel gate')
        .inc({ channel: 'unknown', reason: 'lookup_error' });
      return false;
    }
  }
}
