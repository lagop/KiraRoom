import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma/prisma.service";
import { clientsWhoRefusedMarketing } from "../consent/marketing-consent";
import { EmailService, EmailSendResult } from "../notifications/services/email.service";
import { plainTextPart, withPreheader, withoutPromotion } from "./campaign-content";
import { EmailPacer } from "./email-pacer";
import { EmailSuppressionService } from "./email-suppression.service";
import { EmailUnsubscribeService } from "./email-unsubscribe.service";
import { EmailQuotaService } from "./email-quota.service";

/** How long a send in flight holds its recipient before a sweep may retry it. */
export const SEND_LEASE_MS = 10 * 60_000;
/** Tries per recipient for a retryable error (429, 5xx, no answer). */
export const MAX_SEND_ATTEMPTS = 5;
/** Campaigns worked on per run. */
const CAMPAIGNS_PER_RUN = 20;

/** The wait before try number `attempt + 1`: 1, 2, 4, 8 minutes, at most 30. */
export function retryDelayMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

/** The salon's name as the sender and its email as the reply-to address. */
export function campaignSender(
  campaign: { replyTo: string | null },
  tenant: { name: string | null; email: string | null } | null | undefined,
): { fromName: string; replyTo: string | undefined } {
  return {
    fromName: tenant?.name?.trim() || "",
    replyTo: campaign.replyTo?.trim() || tenant?.email?.trim() || undefined,
  };
}

const NOTHING_SENT =
  "No se envió a nadie: las destinatarias se habían dado de baja, tenían un rebote o una queja, o ya no cumplían las condiciones.";

type SendingCampaign = {
  id: string;
  tenantId: string;
  subject: string;
  previewText: string | null;
  content: string;
  replyTo: string | null;
  sentAt: Date | null;
  tenant: { name: string; email: string | null } | null;
};

/**
 * Sends one-shot email campaigns in the background.
 *
 * "Enviar" used to send every email inside the HTTP request, one after the
 * other: a big list timed the request out, a restart in the middle left the
 * campaign "sending" for ever with half its list never emailed, and a 429
 * from Resend was a permanent failure. Now the request only claims the
 * campaign (draft/scheduled -> sending) and this dispatcher, every minute:
 *
 * 1. starts the scheduled campaigns whose time has come (same claim);
 * 2. gives back the recipients whose send was in flight when the process
 *    died (their lease ran out) -- the recovery sweep: a campaign stuck in
 *    "sending" carries on where it stopped;
 * 3. sends a batch per sending campaign, at the pace EmailPacer allows,
 *    sharing that pace between the campaigns of every salon.
 *
 * A recipient is claimed (pending -> sending) before its email goes out, so
 * two runs never email her twice, and the send carries an idempotency key
 * of her row, so a retry after a send that timed out but went through is
 * not delivered twice either (Resend keeps the key 24 hours). A 429 or 5xx
 * puts her back in the queue with a growing wait, up to MAX_SEND_ATTEMPTS;
 * a 429 also ends the run, since every send after it would get one too.
 * When nobody is left to send to, the campaign is "sent".
 *
 * The rules are checked again for every batch, not only when recipients
 * were added: an active client of the salon, with at least one completed
 * visit (the owner's rule: the LSSI art. 21.2 exception is for clients with
 * a prior relationship), who did not say no to promotions and whose address
 * is not on the salon's suppression list.
 *
 * Each email takes one of the salon's marketing emails of the month
 * (EmailQuotaService) right before it goes out, and gives it back if it did
 * not. With none left the campaign is paused (capPausedAt, and the reason
 * on the card): it stays "sending" with the rest of its list pending, and
 * each run resumes the paused campaigns whose salon has room again -- the
 * next month, or a bono de emails bought.
 */
@Injectable()
export class EmailCampaignSender {
  private readonly logger = new Logger(EmailCampaignSender.name);
  private running = false;
  private again = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly suppressions: EmailSuppressionService,
    private readonly unsubscribes: EmailUnsubscribeService,
    private readonly pacer: EmailPacer,
    private readonly quota: EmailQuotaService,
  ) {}

  /** Starts a run now, without waiting for it (after "Enviar"). */
  kick(): void {
    setImmediate(() => {
      void this.dispatch();
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async dispatch(now: Date = new Date()): Promise<void> {
    if (this.running) {
      // A run is going on: one more right after it, for what was just claimed.
      this.again = true;
      return;
    }
    this.running = true;
    try {
      if (!this.emailService.isConfigured()) return;
      await this.startDue(now);
      await this.quota.resumePaused(now);
      await this.sendBatches(now);
    } catch (err) {
      this.logger.error(`Email campaign dispatcher failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    }
  }

  /** Scheduled campaigns whose time has come: claimed, or back to draft when nobody is on the list. */
  async startDue(now: Date = new Date()): Promise<void> {
    const due = await this.prisma.emailCampaign.findMany({
      where: { status: "scheduled", scheduledAt: { lte: now }, campaignType: { not: "reengagement" } },
      select: { id: true },
      take: CAMPAIGNS_PER_RUN,
    });
    for (const { id } of due) {
      const pending = await this.prisma.emailCampaignRecipient.count({ where: { campaignId: id, status: "pending" } });
      if (pending === 0) {
        await this.prisma.emailCampaign.updateMany({
          where: { id, status: "scheduled" },
          data: {
            status: "draft",
            scheduledAt: null,
            lastError: "Llegó la hora y no tenía destinatarias. Añade clientas y vuelve a programarla.",
          },
        });
        continue;
      }
      const claimed = await this.prisma.emailCampaign.updateMany({
        where: { id, status: "scheduled" },
        data: { status: "sending", lastError: null },
      });
      if (claimed.count > 0) this.logger.log(`Campaign ${id}: scheduled time reached, sending to ${pending}`);
    }
  }

  /** One batch per sending campaign, sharing the minute's pace between them. */
  async sendBatches(now: Date = new Date()): Promise<void> {
    const sending = await this.prisma.emailCampaign.findMany({
      where: { status: "sending", campaignType: { not: "reengagement" }, capPausedAt: null },
      orderBy: { updatedAt: "asc" },
      take: CAMPAIGNS_PER_RUN,
      select: {
        id: true,
        tenantId: true,
        subject: true,
        previewText: true,
        content: true,
        replyTo: true,
        sentAt: true,
        tenant: { select: { name: true, email: true } },
      },
    });
    if (sending.length === 0) return;

    let budget = this.pacer.perMinute;
    const share = Math.max(1, Math.ceil(budget / sending.length));
    for (const campaign of sending) {
      if (budget <= 0) break;
      try {
        const result = await this.sendBatch(campaign, Math.min(share, budget), now);
        budget -= result.attempted;
        if (result.rateLimited) {
          this.logger.warn(`Campaign ${campaign.id}: provider rate limit, pausing until the next run`);
          break;
        }
      } catch (err) {
        // Left "sending": the next run picks it up again.
        this.logger.error(`Campaign ${campaign.id}: batch failed: ${(err as Error).message}`);
      }
    }
  }

  /** Sends up to `limit` of a campaign's due recipients; finishes it when nobody is left. */
  async sendBatch(
    campaign: SendingCampaign,
    limit: number,
    now: Date = new Date(),
  ): Promise<{ attempted: number; sent: number; failed: number; rateLimited: boolean; capReached: boolean }> {
    const outcome = { attempted: 0, sent: 0, failed: 0, rateLimited: false, capReached: false };

    // Recovery: a send in flight when the process stopped holds its
    // recipient only until the lease runs out.
    await this.prisma.emailCampaignRecipient.updateMany({
      where: { campaignId: campaign.id, status: "sending", nextAttemptAt: { lt: now } },
      data: { status: "pending" },
    });

    const due = await this.prisma.emailCampaignRecipient.findMany({
      where: {
        campaignId: campaign.id,
        status: "pending",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    if (due.length === 0) {
      const waiting = await this.prisma.emailCampaignRecipient.count({
        where: { campaignId: campaign.id, status: { in: ["pending", "sending"] } },
      });
      if (waiting === 0) await this.finish(campaign, now);
      return outcome;
    }

    const { tenantId } = campaign;
    const clientIds = [...new Set(due.map((r) => r.clientId).filter((id): id is string => !!id))];
    const clients =
      clientIds.length === 0
        ? []
        : await this.prisma.client.findMany({
            where: { tenantId, id: { in: clientIds }, status: "active" },
            select: { id: true, lastVisit: true },
          });
    const active = new Set(clients.map((c) => c.id));
    const visited = new Set(clients.filter((c) => !!c.lastVisit).map((c) => c.id));

    // No longer one of the salon's active clients (deleted, blocked,
    // inactive), or never came: off the list, as if never added.
    const dropped = due.filter((r) => !r.clientId || !active.has(r.clientId) || !visited.has(r.clientId));
    if (dropped.length > 0) {
      const removed = await this.prisma.emailCampaignRecipient.deleteMany({
        where: { id: { in: dropped.map((r) => r.id) }, campaignId: campaign.id, status: "pending" },
      });
      if (removed.count > 0) {
        await this.prisma.emailCampaign.update({
          where: { id: campaign.id },
          data: { totalRecipients: { decrement: removed.count } },
        });
      }
    }
    const recipients = due.filter((r) => !dropped.includes(r));

    const [refused, suppressed] = await Promise.all([
      clientsWhoRefusedMarketing(this.prisma, tenantId, recipients.map((r) => r.clientId as string)),
      this.suppressions.suppressedAmong(tenantId, recipients.map((r) => r.email)),
    ]);

    const salonName = campaign.tenant?.name ?? "el salón";
    const sender = campaignSender(campaign, campaign.tenant);
    // One-shot campaigns have no promotion behind them: a {{discountCode}}
    // typed into one would reach the client as it is.
    const content = withoutPromotion(campaign.content);
    const limits = await this.quota.limits(tenantId, now);

    for (const recipient of recipients) {
      if (recipient.clientId && refused.has(recipient.clientId)) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "unsubscribed", unsubscribedAt: new Date(), nextAttemptAt: null },
        });
        continue;
      }
      if (suppressed.has(recipient.email.toLowerCase())) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "suppressed",
            nextAttemptAt: null,
            errorMessage: "Dirección dada de baja: baja voluntaria, rebote permanente o queja de spam",
          },
        });
        continue;
      }

      // One of the month's marketing emails, or of the bono. None left: the
      // campaign pauses here, the rest of its list pending.
      const slot = await this.quota.reserve(limits);
      if (!slot.ok) {
        await this.quota.pause(campaign.id, limits, now);
        outcome.capReached = true;
        break;
      }

      const claimed = await this.prisma.emailCampaignRecipient.updateMany({
        where: { id: recipient.id, status: "pending" },
        data: {
          status: "sending",
          attempts: { increment: 1 },
          nextAttemptAt: new Date(Date.now() + SEND_LEASE_MS),
        },
      });
      if (claimed.count === 0) {
        await this.quota.release(slot);
        continue;
      }
      const attempt = (recipient.attempts ?? 0) + 1;

      await this.pacer.wait();
      outcome.attempted++;
      const unsubscribe = this.unsubscribes.link({ kind: "r", id: recipient.id });
      const withFooter = this.unsubscribes.withFooter(content, salonName, unsubscribe.pageUrl);
      const result: EmailSendResult = await this.emailService.sendEmail({
        to: recipient.email,
        subject: campaign.subject,
        html: withPreheader(withFooter, campaign.previewText),
        text: plainTextPart(withFooter),
        fromName: sender.fromName || undefined,
        replyTo: sender.replyTo,
        headers: unsubscribe.headers,
        idempotencyKey: `email-campaign-${recipient.id}`,
        tags: [
          { name: "tenant_id", value: tenantId },
          { name: "campaign_id", value: campaign.id },
        ],
      });

      if (result.success) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "sent",
            sentAt: new Date(),
            messageId: result.id ?? null,
            nextAttemptAt: null,
            errorMessage: null,
          },
        });
        outcome.sent++;
        continue;
      }

      // Not sent: the email is given back to the month (or the bono).
      await this.quota.release(slot);
      const error = result.error?.slice(0, 500) ?? "Error";
      if (result.retryable && attempt < MAX_SEND_ATTEMPTS) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "pending", nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempt)), errorMessage: error },
        });
        if (result.statusCode === 429) {
          outcome.rateLimited = true;
          break;
        }
        continue;
      }

      // Refused before leaving (bad address, provider error) or out of
      // tries: a failure, not a bounce -- the panel's bounces are the
      // receiving server's. "Reintentar fallidos" puts it back in the queue.
      await this.prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "failed", nextAttemptAt: null, errorMessage: error },
      });
      outcome.failed++;
    }

    // Increment, never overwrite: delivery events for the first emails may
    // already be arriving while the batch runs.
    if (outcome.sent > 0) {
      await this.prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { emailsSent: { increment: outcome.sent } },
      });
    }
    this.logger.log(
      `Campaign ${campaign.id}: batch of ${due.length}: ${outcome.sent} sent, ${outcome.failed} failed, ${dropped.length} dropped`,
    );
    return outcome;
  }

  /** Nobody left to send to: the campaign is sent. */
  private async finish(campaign: SendingCampaign, now: Date) {
    const sent = await this.prisma.emailCampaignRecipient.count({
      where: { campaignId: campaign.id, sentAt: { not: null } },
    });
    await this.prisma.emailCampaign.updateMany({
      where: { id: campaign.id, status: "sending" },
      data: {
        status: "sent",
        // The first time it went out; "Reintentar fallidos" keeps it.
        sentAt: campaign.sentAt ?? now,
        lastError: sent === 0 ? NOTHING_SENT : null,
      },
    });
    this.logger.log(`Campaign ${campaign.id}: finished, ${sent} emails sent in total`);
  }
}
