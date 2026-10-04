import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FeatureFlagService } from '../../common/feature-flags/feature-flag.service';
import { VirtualReceptionistService } from '../virtual-receptionist.service';
import { ChannelRegistry } from './channel.registry';
import { ChannelCredentialsService } from './channel-credentials.service';
import { TelegramBotClient } from './telegram-bot.client';

export type ChatAppChannel = 'facebook' | 'instagram' | 'telegram';

/** One inbound message from Messenger, Instagram Direct or Telegram. */
export interface InboundChatMessage {
  channel: ChatAppChannel;
  /** Provider message id (Meta `mid`, Telegram `update_id`): handled once. */
  id: string;
  /** Who wrote: Page-scoped id, Instagram-scoped id or Telegram chat id. */
  from: string;
  text?: string;
  /** A photo, voice note, sticker... with no text the receptionist can read. */
  hasAttachment?: boolean;
  /** The person's display name, when the channel gives it (Telegram). */
  name?: string;
}

const SEEN_TTL_MS = 60 * 60 * 1000;
const PER_SENDER_PER_HOUR = 30;

/**
 * The virtual receptionist on Messenger, Instagram Direct and Telegram.
 *
 * Messages to these channels used to be written to the log and nothing
 * else. Now each one goes to the same receptionist as the web chat and
 * WhatsApp, and its answer goes back through the channel's provider (the
 * ChannelRegistry, which VirtualReceptionistService.sendMessage already
 * calls for the conversation's channel). Same safeguards as WhatsApp:
 *
 * - The webhook is answered at once (Meta wants a 200 within 5 s) and the
 *   work happens afterwards, one message at a time per sender, so replies
 *   keep their order.
 * - Meta and Telegram retry deliveries: each message id is handled once.
 * - A cap per sender and hour limits what a flood of messages can cost.
 *
 * When the receptionist fails, or answers without sending (the monthly AI
 * allowance ran out), the person still gets a reply from here.
 */
@Injectable()
export class ChannelReceptionistService {
  private readonly logger = new Logger(ChannelReceptionistService.name);
  private readonly seen = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly receptionist: VirtualReceptionistService,
    private readonly registry: ChannelRegistry,
    private readonly credentials: ChannelCredentialsService,
    private readonly telegram: TelegramBotClient,
  ) {}

  /** Queues the message and returns at once. */
  enqueue(tenantId: string, message: InboundChatMessage): Promise<void> {
    if (!message.id || !message.from) return Promise.resolve();
    if (this.alreadySeen(`${message.channel}:${tenantId}:${message.id}`)) return Promise.resolve();
    const key = `${tenantId}:${message.channel}:${message.from}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(tenantId, message))
      .catch((err) =>
        this.logger.error(`${message.channel} message ${message.id} failed: ${(err as Error).message}`),
      )
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
    return next;
  }

  private async handle(tenantId: string, message: InboundChatMessage): Promise<void> {
    if (!(await this.flags.isEnabled(tenantId, 'virtual_receptionist' as any))) return;

    if (!this.withinRate(`${tenantId}:${message.channel}:${message.from}`)) {
      this.logger.warn(
        `${message.channel} sender over ${PER_SENDER_PER_HOUR}/h for tenant ${tenantId}; ignored`,
      );
      return;
    }

    const reply = (text: string, conversationId = '') =>
      this.registry.send(tenantId, message.channel, {
        externalUserId: message.from,
        text,
        ctx: { tenantId, conversationId },
      });

    const text = message.text?.trim();
    if (!text) {
      if (message.hasAttachment) {
        await reply('Por ahora solo puedo leer mensajes de texto. Escríbeme lo que necesites y te ayudo.');
      }
      return;
    }

    if (message.channel === 'telegram') await this.showTyping(tenantId, message.from);

    const response = await this.receptionist.sendMessage({
      clientId: `${message.channel}-${message.from}`,
      salonId: tenantId,
      tenantId,
      // Telegram's "Start" button sends /start: a greeting, not a command.
      message: (text === '/start' ? 'Hola' : text).slice(0, 2000),
      channel: message.channel,
      metadata: {
        externalUserId: message.from,
        ...(message.name ? { clientName: message.name, recipientName: message.name } : {}),
      },
    } as any);

    if (response?.id === 'error-response' || !response?.content?.trim()) {
      await reply(await this.apology(tenantId));
      return;
    }
    if (!(response as any).channelDispatched) {
      // sendMessage returned without sending (allowance exhausted, or the
      // provider call failed): send its answer from here, once.
      const sent = await reply(response.content, response.id).catch((err) => {
        this.logger.error(`${message.channel} reply for tenant ${tenantId} failed: ${(err as Error).message}`);
        return null;
      });
      if (!sent) this.logger.warn(`${message.channel} reply for tenant ${tenantId} was not delivered`);
    }
  }

  private async showTyping(tenantId: string, chatId: string): Promise<void> {
    const creds = await this.credentials.telegram(tenantId).catch(() => null);
    if (creds) await this.telegram.sendTyping(creds.botToken, chatId).catch(() => undefined);
  }

  private async apology(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { phone: true } });
    return tenant?.phone
      ? `Ahora mismo no puedo responderte. Si es urgente, llama al salón al ${tenant.phone}.`
      : 'Ahora mismo no puedo responderte. Vuelve a escribirme en unos minutos, por favor.';
  }

  private alreadySeen(id: string): boolean {
    const now = Date.now();
    if (this.seen.size > 5000) {
      for (const [k, at] of this.seen) if (now - at > SEEN_TTL_MS) this.seen.delete(k);
    }
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }

  private withinRate(key: string): boolean {
    const now = Date.now();
    const times = (this.recent.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    times.push(now);
    this.recent.set(key, times);
    return times.length <= PER_SENDER_PER_HOUR;
  }
}
