import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Resend's default limit is 2 requests per second. */
export const DEFAULT_CAMPAIGN_RATE_PER_MINUTE = 120;

/** The configured rate, within sane bounds; the default when unset or not a number. */
export function campaignRatePerMinute(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CAMPAIGN_RATE_PER_MINUTE;
  return Math.min(Math.floor(n), 6000);
}

/**
 * Spaces out marketing emails: at most EMAIL_CAMPAIGN_RATE_PER_MINUTE per
 * minute, all salons together.
 *
 * Every salon sends from the same KiraRoom domain and Resend key. A salon
 * with 5,000 clients pressing "Enviar" used to fire them as fast as the
 * loop could go: Resend answered 429 to most of them (they ended "failed")
 * and the burst itself is what mailbox providers read as spam from the
 * domain, which every other salon's emails then pay for. Campaigns and the
 * re-engagement job both wait for a slot here.
 *
 * In-process: one backend instance sends campaigns (the dispatcher's
 * claims keep a second one from sending the same email twice, not from
 * adding its own rate).
 */
@Injectable()
export class EmailPacer {
  readonly perMinute: number;
  private nextSlot = 0;

  constructor(config: ConfigService) {
    this.perMinute = campaignRatePerMinute(config.get<string>("EMAIL_CAMPAIGN_RATE_PER_MINUTE"));
  }

  get intervalMs(): number {
    return 60_000 / this.perMinute;
  }

  /** Resolves when the next email may go out. */
  async wait(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  /** Overridden in tests. */
  protected now(): number {
    return Date.now();
  }

  /** Overridden in tests. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
