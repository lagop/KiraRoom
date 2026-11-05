import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { createHmac } from "crypto";
import { PrismaService } from "../../common/prisma/prisma.service";
import { issueVisitorToken, legacyVisitorUuid, readVisitorToken, visitorKey } from "./visitor-token";

/**
 * Messages a day one person can send to a salon's receptionist from its
 * site. A booking takes about 7; the per-IP limit (20 a minute) stops bursts,
 * this stops one visitor from spending a salon's AI messages all day.
 */
export const VISITOR_DAILY_MESSAGES = 40;

/**
 * Messages a day from one address to one salon's chat, whatever visitor id
 * they carry. The visitor limit alone was reset by dropping the token (the
 * server issues a new one), so one person could spend a salon's whole daily
 * AI allowance -- 50 messages on Esencial, shared with WhatsApp and the other
 * channels -- in minutes. Below that allowance on purpose; still room for a
 * few visitors behind the same address (a salon's tablet, a shared network).
 */
export const PUBLIC_CHAT_IP_DAILY_MESSAGES = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How often old address counters are dropped. */
const SWEEP_MS = 60 * 60 * 1000;

/**
 * Whoever writes: an id the server issued, signed, kept by the browser.
 * (Salon clients have no accounts, so nobody is recognised by a session.)
 */
export type ChatIdentity = { kind: "visitor"; clientId: string; visitorToken: string };

export class ChatDailyLimitException extends HttpException {
  constructor(limit: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: "chat_daily_limit",
        limit,
        message:
          "Has llegado al máximo de mensajes de hoy con el asistente. " +
          "Puedes reservar desde esta página o llamar al salón.",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Who is writing on the public chat, and whether they may write more today. */
@Injectable()
export class PublicChatAccessService {
  /**
   * Messages of the last 24 hours per (salon, address), keyed by a keyed
   * hash so no address is held as such. In this process's memory, like the
   * per-minute rate limit (ThrottlerBehindProxyGuard): right for the single
   * API instance there is today; a restart starts the count again.
   */
  private readonly byAddress = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly prisma: PrismaService) {}

  private secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error("JWT_SECRET is required to sign chat visitors");
    return s;
  }

  identify(input: { salonId: string; visitorToken?: string; clientId?: string }): ChatIdentity {
    const uuid =
      readVisitorToken(this.secret(), input.salonId, input.visitorToken) ??
      legacyVisitorUuid(input.clientId) ??
      undefined;
    const visitorToken = issueVisitorToken(this.secret(), input.salonId, uuid);
    const visitorUuid = readVisitorToken(this.secret(), input.salonId, visitorToken)!;
    return { kind: "visitor", clientId: visitorKey(visitorUuid), visitorToken };
  }

  /**
   * The visitor's own daily limit, then the address's (`ip`: the client
   * address the rate limiter uses, `req.ip` behind the trusted proxies).
   * A new visitor id from the same address keeps counting against the same
   * address allowance, so dropping the token no longer starts afresh.
   */
  async assertWithinDailyLimit(identity: ChatIdentity, tenantId: string, now = new Date(), ip?: string): Promise<void> {
    const sent = await this.prisma.chatMessage.count({
      where: {
        role: "user",
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        conversation: { tenantId, context: { path: ["visitorKey"], equals: identity.clientId } },
      },
    });
    if (sent >= VISITOR_DAILY_MESSAGES) throw new ChatDailyLimitException(VISITOR_DAILY_MESSAGES);
    if (ip) this.takeAddressAllowance(ip, tenantId, now.getTime());
  }

  private takeAddressAllowance(ip: string, tenantId: string, now: number): void {
    this.sweep(now);
    const key = createHmac("sha256", this.secret()).update(`chat-ip|${tenantId}|${ip}`).digest("base64url");
    const since = now - DAY_MS;
    const times = (this.byAddress.get(key) ?? []).filter((t) => t > since);
    if (times.length >= PUBLIC_CHAT_IP_DAILY_MESSAGES) {
      this.byAddress.set(key, times);
      throw new ChatDailyLimitException(PUBLIC_CHAT_IP_DAILY_MESSAGES);
    }
    times.push(now);
    this.byAddress.set(key, times);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = now;
    const since = now - DAY_MS;
    for (const [key, times] of this.byAddress) {
      if (!times.some((t) => t > since)) this.byAddress.delete(key);
    }
  }
}
