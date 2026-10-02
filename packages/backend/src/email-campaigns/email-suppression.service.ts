import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";

/** "unsubscribed": the client used the unsubscribe link (EmailUnsubscribeService). */
export type SuppressionReason = "hard_bounce" | "complaint" | "unsubscribed";

/**
 * The salon's do-not-email list for marketing.
 *
 * Sending again to an address that hard-bounced or complained is what gets
 * a sending domain throttled or blocked, and every salon sends from the same
 * KiraRoom domain -- so one salon's dead list would hurt all of them. The
 * Resend webhook and the unsubscribe link fill this table; every campaign
 * send reads it first.
 */
@Injectable()
export class EmailSuppressionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Which of `emails` this tenant must not send marketing to (lower-cased). */
  async suppressedAmong(tenantId: string, emails: Array<string | null | undefined>): Promise<Set<string>> {
    const wanted = [...new Set(emails.filter((e): e is string => !!e).map((e) => e.toLowerCase()))];
    if (wanted.length === 0) return new Set();
    const rows = await this.prisma.emailSuppression.findMany({
      where: { tenantId, email: { in: wanted } },
      select: { email: true },
    });
    return new Set(rows.map((r) => r.email));
  }

  async suppress(tenantId: string, email: string, reason: SuppressionReason, detail?: string | null) {
    const address = email.toLowerCase();
    // A complaint outranks a bounce in what it says about the address, but
    // either one already stops the sends; the first reason is kept.
    await this.prisma.emailSuppression.upsert({
      where: { tenantId_email: { tenantId, email: address } },
      create: { tenantId, email: address, reason, detail: detail?.slice(0, 500) ?? null },
      update: {},
    });
  }

  async count(tenantId: string): Promise<number> {
    return this.prisma.emailSuppression.count({ where: { tenantId } });
  }
}
