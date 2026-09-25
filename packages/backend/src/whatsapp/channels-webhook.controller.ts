import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { TelegramChannelProvider } from '../virtual-receptionist/channels/telegram-channel.provider';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { MetricsService, COUNTERS } from '../common/observability/metrics.service';
import { timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

/**
 * P2A-receptionist-v2 H-4: public webhooks for the new chat channels.
 *
 *  POST /channels/webhooks/meta          — Meta Cloud messaging
 *    events (Messenger + Instagram DMs). Same endpoint that the
 *    legacy /webhooks/meta/whatsapp hits; we re-route here for clarity
 *    because the dispatcher reads `object` to differentiate.
 *
 *  POST /channels/webhooks/telegram      — Telegram Bot API webhook.
 *    Verifies the X-Telegram-Bot-Api-Secret-Token header against the
 *    tenant's bot token (looked up by the chat_id inside the payload).
 *
 *  Both handlers dispatch through `whatsapp.processInbound()` which
 *  is the single ingress point; the channel registry then routes the
 *  outbound reply to the right provider.
 */
@ApiTags('channels-webhooks')
@ApiTags('channels-webhooks')
@Controller('channels/webhooks')
export class ChannelsWebhookController {
  private readonly logger = new Logger(ChannelsWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly whatsapp: WhatsAppService,
    private readonly telegram: TelegramChannelProvider,
    private readonly featureFlags: FeatureFlagService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Meta Cloud webhook (Messenger + Instagram DMs).
   *
   * `object` is `'page'` for Messenger and `'instagram'` for IG DMs.
   * The `recipient.id` is always the Page ID; we look up the tenant
   * via the `whatsAppConnection.pageId` index (loaded on demand) OR
   * the new multichannel Meta config (preferred).
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
    // Signature verification.
    //
    // This used to check only that the header EXISTED, and only in
    // production -- so anyone who knew a pageId could inject messages
    // into a tenant's AI receptionist with `x-hub-signature-256: x`,
    // booking appointments and burning LLM budget. The HMAC is now
    // actually computed against the raw body.
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

    const entries = body?.entry ?? [];
    for (const entry of entries) {
      const platform: 'facebook' | 'instagram' =
        body?.object === 'instagram' ? 'instagram' : 'facebook';
      const pageId: string | undefined =
        entry?.id ?? entry?.messaging?.[0]?.recipient?.id;
      if (!pageId) continue;
      const messaging = entry?.messaging ?? [];
      for (const m of messaging) {
        const text = m?.message?.text;
        if (!text) continue;
        const tenantId = await this.lookupTenantByPageId(pageId);
        if (!tenantId) continue;
        // H-4 multichannel gate: Esencial tenants (no `multichannel`
        // feature key) cannot receive messages on Meta channels even
        // if a pageId was wired up previously. Drop silently with a
        // warning so we don't leak the gate via response shape.
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
        await this.whatsapp.processInbound({
          tenantId,
          channel: platform,
          externalUserId: m.sender.id,
          text,
          messageId: m.message.mid });
      }
    }
    res.json({ received: true });
  }

  /**
   * Telegram Bot API webhook. Header verification uses the secret
   * token registered for the bot that received the message. The bot
   * token is looked up via the chat_id (which is unique per bot).
   */
  @Post('telegram')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 1000, limit: 30 } })
  async handleTelegram(
    @Headers('x-telegram-bot-api-secret-token') secret: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const chatId = body?.message?.chat?.id;
    if (!chatId) {
      this.logger.warn('Telegram webhook missing message.chat.id');
      res.json({ received: true });
      return;
    }
    const expectedSecret = await this.lookupTelegramWebhookSecretForChat(chatId);
    if (!expectedSecret) {
      this.logger.warn(
        `Telegram webhook: no secret registered for chat ${chatId}`,
      );
      res.json({ received: true });
      return;
    }
    // Constant-time compare, enforced in every environment -- it used to be
    // production-only with a plain !==.
    const given = Buffer.from(secret ?? '');
    const want = Buffer.from(expectedSecret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException('Invalid Telegram secret token');
    }

    const normalized = await this.telegram.parseInbound(req);
    if (!normalized || !normalized.isFromUser) {
      res.json({ received: true });
      return;
    }
    const tenantId = await this.lookupTenantByTelegramChat(chatId);
    if (!tenantId) {
      this.logger.warn(`Telegram chat ${chatId} not linked to any tenant`);
      res.json({ received: true });
      return;
    }
    // H-4 multichannel gate: same as the Meta handler above.
    if (!(await this.isMultichannelEnabled(tenantId))) {
      this.logger.warn(
        `Telegram webhook: tenant ${tenantId} lacks the 'multichannel' feature; ignoring message from chat ${chatId}`,
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
    await this.whatsapp.processInbound({
      tenantId,
      channel: 'telegram',
      externalUserId: String(chatId),
      text: normalized.text,
      messageId: normalized.metadata['messageId'] as string | undefined });
    res.json({ received: true });
  }

  // ------------------------------------------------------------------
  // Tenant lookup helpers. The map grows as we add new channels; today
  // the canonical resolver is the WhatsAppConnection (pageId) for
  // Meta + a future `multichannel.telegram.<chatId>` JSON column.
  // ------------------------------------------------------------------
  private pageIndex = new Map<string, string>();
  private pageIndexLoadedAt = 0;

  private async lookupTenantByPageId(pageId: string): Promise<string | null> {
    if (Date.now() - this.pageIndexLoadedAt > 5 * 60 * 1000) {
      const rows = await this.prisma.whatsAppConnection.findMany({
        select: { tenantId: true, phoneNumberId: true } });
      this.pageIndex.clear();
      for (const r of rows) {
        // In the multichannel model the pageId is stored in
        // Tenant.features.multichannel.meta.pageId. The legacy field
        // is phoneNumberId; the lookup accepts both for now.
        this.pageIndex.set(r.phoneNumberId, r.tenantId);
      }
      this.pageIndexLoadedAt = Date.now();
    }
    return this.pageIndex.get(pageId) ?? null;
  }

  /**
   * The shared secret Telegram sends in X-Telegram-Bot-Api-Secret-Token.
   *
   * Prefers a dedicated `telegram.webhookSecret`, which is what Telegram
   * intends: a value distinct from the bot token, so someone who sees the
   * header in a log or a proxy cannot then control the bot. Falls back to
   * the bot token for tenants configured before the wizard started minting
   * a secret, so their webhook keeps working until they reconnect.
   */
  private async lookupTelegramWebhookSecretForChat(
    chatId: number | string,
  ): Promise<string | null> {
    // Placeholder: when the multichannel schema is wired, the bot
    // token is stored in Tenant.features.multichannel.telegram.
    // The lookup is `features ? features.multichannel?.telegram?.botToken
    // : null`. For now the Telegram provider's verifyWebhook trusts
    // the same ctx metadata so the dispatcher flows correctly.
    const tenants = await this.prisma.tenant.findMany({
      where: {},
      select: { id: true, features: true } });
    for (const t of tenants) {
      const f = (t.features as any) ?? {};
      const tg = f?.multichannel?.telegram;
      if (tg?.linkedChats?.includes(String(chatId))) {
        const secret = (tg.webhookSecret ?? tg.botToken) as string | undefined;
        if (secret) return secret;
      }
    }
    return null;
  }

  private async lookupTenantByTelegramChat(
    chatId: number | string,
  ): Promise<string | null> {
    const tenants = await this.prisma.tenant.findMany({
      where: {},
      select: { id: true, features: true } });
    for (const t of tenants) {
      const f = (t.features as any) ?? {};
      const tg = f?.multichannel?.telegram;
      if (tg?.linkedChats?.includes(String(chatId))) {
        return t.id;
      }
    }
    return null;
  }

  /**
   * H-4: check the tenant has the `multichannel` feature key. Wraps
   * `FeatureFlagService.isEnabled` so the public webhook path doesn't
   * depend on the controller-level FeatureGuard (which is JWT-based
   * and therefore not applicable to Meta/Telegram server-to-server
   * callbacks).
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
      // Fail-closed: if we can't verify the entitlement we drop the
      // message rather than risk sending to a tenant that downgraded.
      return false;
    }
  }
}
