import { createHash } from "crypto";
import { RedisService } from "./redis.service";

/** A webhook delivery id is remembered this long: Meta and Telegram retry for hours. */
const SEEN_TTL_S = 24 * 60 * 60;
const HOUR_S = 60 * 60;

/**
 * Handling each inbound chat message once, and capping what one sender can
 * trigger per hour, for the receptionist on WhatsApp, Messenger, Instagram
 * and Telegram.
 *
 * Both lived in Maps in the process: a restart or deploy forgot them (a
 * retried delivery was answered twice, the cap started over), a second
 * instance had its own, and the per-sender map was never pruned. Now they
 * are Redis keys with an expiry (RedisService, with its in-memory fallback
 * when Redis is not configured or fails, which is also what the unit tests
 * use). Senders are hashed in the keys: no phone number in Redis.
 */
export class InboundGuard {
  constructor(
    private readonly redis: RedisService,
    private readonly prefix: string,
  ) {}

  /** True the first time this delivery is seen; false for a repeat. */
  firstDelivery(id: string): Promise<boolean> {
    return this.redis.setIfAbsent(`${this.prefix}:seen:${digest(id)}`, "1", SEEN_TTL_S);
  }

  /** Counts one message from this sender in the current clock hour; false once over `cap`. */
  async withinHourlyCap(sender: string, cap: number, now = Date.now()): Promise<boolean> {
    const hour = Math.floor(now / (HOUR_S * 1000));
    const n = await this.redis.increment(`${this.prefix}:rate:${digest(sender)}:${hour}`, HOUR_S);
    return n <= cap;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
