import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FeatureFlagService } from '../../common/feature-flags/feature-flag.service';
import { RedisService } from '../../common/cache/redis.service';
import { InboundGuard } from '../../common/cache/inbound-guard';
import { mediaReply } from '../../whatsapp/inbound-kinds';
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
  /** A photo, voice note, file... with no text the receptionist can read (stickers are dropped earlier). */
  hasAttachment?: boolean;
  /** The person's display name, when the channel gives it (Telegram). */
  name?: string;
}

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
 * - Meta and Telegram retry deliveries: each message id is handled once,
 *   and the cap per sender and hour holds, across restarts and instances
 *   (Redis, InboundGuard).
 * - A channel the salon switched off in the panel, or whose token Meta or
 *   Telegram refused, is not answered and spends no AI: the message stays
 *   in the salon's own inbox (Meta Business Suite).
 *
 * When the receptionist fails, or answers without sending (the monthly AI
 * allowance ran out), the person still gets a reply from here.
 */
@Injectable()
export class ChannelReceptionistService {
  private readonly logger = new Logger(ChannelReceptionistService.name);
  private readonly chains = new Map<string, Promise<void>>();
  private readonly guard: InboundGuard;

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly receptionist: VirtualReceptionistService,
    private readonly registry: ChannelRegistry,
    private readonly credentials: ChannelCredentialsService,
    private readonly telegram: TelegramBotClient,
    redis: RedisService,
  ) {
    this.guard = new InboundGuard(redis, 'vr:chan');
  }

  /** Queues the message and returns at once. */
  enqueue(tenantId: string, message: InboundChatMessage): Promise<void> {
    if (!message.id || !message.from) return Promise.resolve();
    const key = `${tenantId}:${message.channel}:${message.from}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    // The repeat check runs inside the sender's chain, so messages keep
    // their order even though it is asynchronous now.
    const next = previous
      .then(async () => {
        if (!(await this.guard.firstDelivery(`${message.channel}:${tenantId}:${message.id}`))) return;
        await this.handle(tenantId, message);
      })
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
    // Switched off in Ajustes > Canales ("puedes apagar un canal sin
    // desconectarlo"): it used to go through the model, count against the
    // monthly allowance, and have its answer dropped by the registry.
    if (!(await this.registry.isChannelEnabled(tenantId, message.channel))) return;
    const lost = await this.credentials.accessLost(tenantId);
    if (message.channel === 'telegram' ? lost.telegram : lost.facebook) {
      this.logger.warn(`${message.channel} message for tenant ${tenantId} not answered: the token was refused`);
      return;
    }

    if (!(await this.guard.withinHourlyCap(`${tenantId}:${message.channel}:${message.from}`, PER_SENDER_PER_HOUR))) {
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
        const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { phone: true } });
        await reply(mediaReply(message.channel, tenant?.phone));
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

    // Paused from the panel: the message is kept, nothing is sent.
    if ((response as { paused?: boolean } | null)?.paused) return;
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
}
