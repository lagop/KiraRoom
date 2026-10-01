import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { VirtualReceptionistService } from "../virtual-receptionist/virtual-receptionist.service";
import { MetaCloudApiClient } from "./meta-cloud-api.client";

/** One inbound WhatsApp message, as the Cloud API webhook delivers it. */
export interface InboundWhatsApp {
  id: string;
  /** The sender's WhatsApp id: their phone number, digits only. */
  from: string;
  type: string;
  text?: string;
  profileName?: string;
}

const SEEN_TTL_MS = 60 * 60 * 1000;
const PER_SENDER_PER_HOUR = 30;

/**
 * The virtual receptionist on WhatsApp.
 *
 * Messages reaching a salon's WhatsApp Business number used to be dropped:
 * the webhook only looked for opt-out words. Now each text goes to the same
 * receptionist as the web chat -- same rules, same two-step booking -- and
 * its answer goes back as a WhatsApp reply from the salon's number.
 *
 * - The webhook is answered at once; the work happens afterwards, one
 *   message at a time per sender, so Meta never times out and replies keep
 *   their order.
 * - Meta retries deliveries: each message id is handled once.
 * - The sender's phone is the conversation key and the booking phone, so
 *   the receptionist does not have to ask for it.
 * - A cap per sender and hour limits what a flood of messages can cost.
 */
@Injectable()
export class WhatsAppReceptionistService {
  private readonly logger = new Logger(WhatsAppReceptionistService.name);
  private readonly seen = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaCloudApiClient,
    private readonly flags: FeatureFlagService,
    @Inject(forwardRef(() => VirtualReceptionistService))
    private readonly receptionist: VirtualReceptionistService,
  ) {}

  /** Queues the message and returns at once. */
  enqueue(tenantId: string, message: InboundWhatsApp): Promise<void> {
    if (!message.id || !message.from || this.alreadySeen(message.id)) return Promise.resolve();
    const key = `${tenantId}:${message.from}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(tenantId, message))
      .catch((err) => this.logger.error(`WhatsApp message ${message.id} failed: ${(err as Error).message}`))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
    return next;
  }

  private async handle(tenantId: string, message: InboundWhatsApp): Promise<void> {
    const connection = await this.prisma.whatsAppConnection.findUnique({
      where: { tenantId },
      select: { phoneNumberId: true, accessTokenEnc: true, isActive: true },
    });
    if (!connection?.isActive) return;
    if (!(await this.flags.isEnabled(tenantId, "virtual_receptionist" as any))) return;

    const token = this.meta.decryptToken(connection.accessTokenEnc);
    const reply = (body: string) => this.meta.sendText(token, connection.phoneNumberId, message.from, body);
    await this.meta.markRead(token, connection.phoneNumberId, message.id).catch(() => undefined);

    if (!this.withinRate(`${tenantId}:${message.from}`)) {
      this.logger.warn(`WhatsApp sender over ${PER_SENDER_PER_HOUR}/h for tenant ${tenantId}; ignored`);
      return;
    }

    if (message.type !== "text" || !message.text?.trim()) {
      await reply("Por ahora solo puedo leer mensajes de texto. Escríbeme lo que necesites y te ayudo.");
      return;
    }

    const phone = `+${message.from}`;
    const response = await this.receptionist.sendMessage({
      clientId: `whatsapp-${message.from}`,
      salonId: tenantId,
      tenantId,
      message: message.text.slice(0, 2000),
      channel: "whatsapp",
      metadata: {
        externalUserId: phone,
        clientPhone: phone,
        ...(message.profileName ? { clientName: message.profileName } : {}),
      },
    } as any);

    const text =
      response?.id === "error-response" || !response?.content?.trim()
        ? await this.apology(tenantId)
        : toWhatsAppText(response.content);
    const sent = await reply(text);
    if (sent?.error) {
      this.logger.error(`WhatsApp reply to tenant ${tenantId} failed: ${sent.error.code} ${sent.error.message}`);
    }
  }

  private async apology(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { phone: true } });
    return tenant?.phone
      ? `Ahora mismo no puedo responderte. Si es urgente, llama al salón al ${tenant.phone}.`
      : "Ahora mismo no puedo responderte. Vuelve a escribirme en unos minutos, por favor.";
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

/**
 * The receptionist writes Markdown for the web chat. WhatsApp has its own
 * marks: *bold*, _italic_. Headings and links in [text](url) form are not
 * rendered, so they become plain text.
 */
export function toWhatsAppText(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1: $2")
    .trim();
}
