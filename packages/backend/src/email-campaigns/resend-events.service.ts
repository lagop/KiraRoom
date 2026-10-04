import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { EmailSuppressionService } from "./email-suppression.service";

/**
 * What Resend posts to the webhook (resend.com/docs/webhooks). Only the
 * fields this service reads are typed.
 */
export interface ResendWebhookEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
    click?: { link?: string };
    failed?: { reason?: string };
  };
}

/** Event types recorded per campaign recipient, and their analytics name. */
const TRACKED: Record<string, string> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
};

/**
 * The engagement statuses only ever move forward: a late `delivered` must
 * not turn an `opened` recipient back into `delivered` (Resend does not
 * guarantee order). Bounce, complaint and failure are outcomes, not steps,
 * and always win.
 */
const LOWER_THAN: Record<string, string[]> = {
  delivered: ["pending", "scheduled", "sent"],
  opened: ["pending", "scheduled", "sent", "delivered"],
  clicked: ["pending", "scheduled", "sent", "delivered", "opened"],
};

/**
 * Turns Resend's delivery events into campaign numbers.
 *
 * Before this the webhook was unreachable (it required a session) and the
 * panel's "delivered" was the number of emails Resend accepted; opens,
 * clicks and bounces stayed at zero forever. Now each recipient row carries
 * what actually happened to its email, the campaign counters count
 * recipients (an email opened five times is one open), and hard bounces and
 * complaints put the address on the salon's suppression list.
 *
 * Idempotent: Svix redelivers on timeouts, so the svix-id is stored on the
 * analytics row (unique) and a repeat is dropped before anything is counted.
 * The per-recipient "first time" checks are conditional updates, so two
 * different events racing for the same recipient cannot double-count either.
 */
@Injectable()
export class ResendEventsService {
  private readonly logger = new Logger(ResendEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppressions: EmailSuppressionService,
  ) {}

  async handle(event: ResendWebhookEvent, eventId: string): Promise<void> {
    const emailId = event.data?.email_id;
    if (!emailId || !TRACKED[event.type]) return;

    const recipient = await this.prisma.emailCampaignRecipient.findFirst({
      where: { messageId: emailId },
      select: { id: true, email: true, campaignId: true, campaign: { select: { tenantId: true } } },
    });

    if (recipient) {
      await this.handleCampaignEvent(event, eventId, recipient);
    } else {
      await this.handleTransactionalEvent(event, emailId);
    }
  }

  private async handleCampaignEvent(
    event: ResendWebhookEvent,
    eventId: string,
    recipient: { id: string; email: string; campaignId: string; campaign: { tenantId: string } },
  ) {
    const kind = TRACKED[event.type];
    const at = eventTime(event);
    const data = event.data ?? {};

    const seen = await this.prisma.emailCampaignAnalytics.findUnique({ where: { eventId }, select: { id: true } });
    if (seen) {
      this.logger.debug(`Resend event ${eventId} already processed`);
      return;
    }

    // Every step below is idempotent on its own, so a delivery that fails
    // half-way can be retried by Svix; the analytics row goes last and marks
    // the event as done.
    switch (kind) {
      case "delivered":
        await this.firstTime(recipient, "deliveredAt", at, "emailsDelivered");
        await this.advanceStatus(recipient.id, "delivered");
        break;
      case "opened":
        await this.firstTime(recipient, "openedAt", at, "emailsOpened");
        await this.advanceStatus(recipient.id, "opened");
        break;
      case "clicked":
        await this.firstTime(recipient, "clickedAt", at, "clicks");
        await this.advanceStatus(recipient.id, "clicked");
        break;
      case "bounced": {
        const bounce = data.bounce ?? {};
        const counted = await this.firstTime(recipient, "bouncedAt", at, "bounces");
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "bounced", errorMessage: bounce.message?.slice(0, 500) ?? "Bounced" },
        });
        // Only a permanent bounce says the mailbox is gone. A temporary one
        // (full mailbox, greylisting) is counted but the address stays.
        if (isPermanent(bounce.type)) {
          await this.suppressions.suppress(recipient.campaign.tenantId, recipient.email, "hard_bounce", bounce.message);
        }
        if (counted) this.logger.log(`Campaign ${recipient.campaignId}: bounce (${bounce.type ?? "unknown"})`);
        break;
      }
      case "complained":
        await this.firstTime(recipient, "complainedAt", at, "complaints");
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "complained" },
        });
        await this.suppressions.suppress(recipient.campaign.tenantId, recipient.email, "complaint");
        break;
      case "failed":
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "failed", errorMessage: data.failed?.reason?.slice(0, 500) ?? "Failed" },
        });
        break;
    }

    try {
      await this.prisma.emailCampaignAnalytics.create({
        data: {
          campaignId: recipient.campaignId,
          eventType: kind,
          timestamp: at,
          email: recipient.email,
          messageId: data.email_id,
          eventId,
          // The clicked link is what the salon wants to see. The client's IP
          // and browser are personal data the panel never shows: not kept.
          url: data.click?.link?.slice(0, 2000),
        },
      });
    } catch (err) {
      // Two concurrent deliveries of the same event: the other one won.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
  }

  /**
   * Stamps the recipient's timestamp if it is still empty and, only then,
   * bumps the campaign counter. Returns whether this was the first time.
   */
  private async firstTime(
    recipient: { id: string; campaignId: string },
    field: "deliveredAt" | "openedAt" | "clickedAt" | "bouncedAt" | "complainedAt",
    at: Date,
    counter: "emailsDelivered" | "emailsOpened" | "clicks" | "bounces" | "complaints",
  ): Promise<boolean> {
    const stamped = await this.prisma.emailCampaignRecipient.updateMany({
      where: { id: recipient.id, [field]: null },
      data: { [field]: at },
    });
    if (stamped.count === 0) return false;
    await this.prisma.emailCampaign.update({
      where: { id: recipient.campaignId },
      data: { [counter]: { increment: 1 } },
    });
    return true;
  }

  private async advanceStatus(recipientId: string, status: "delivered" | "opened" | "clicked") {
    await this.prisma.emailCampaignRecipient.updateMany({
      where: { id: recipientId, status: { in: LOWER_THAN[status] } },
      data: { status },
    });
  }

  /**
   * Emails that are not campaign emails: invites, password resets, trial
   * notices. A permanent bounce stamps the User so EmailService stops
   * sending to a dead address (shouldSkipBouncedUser); the delivery row, if
   * one was recorded under this id, gets the new status.
   */
  private async handleTransactionalEvent(event: ResendWebhookEvent, emailId: string) {
    const data = event.data ?? {};
    const status = TRACKED[event.type].toUpperCase();
    await this.prisma.notificationDelivery.updateMany({
      where: { externalId: emailId },
      data: {
        status,
        ...(status === "DELIVERED" ? { deliveredAt: eventTime(event) } : {}),
        ...(status === "BOUNCED" || status === "FAILED"
          ? { failedAt: eventTime(event), failureReason: data.bounce?.message ?? data.failed?.reason ?? null }
          : {}),
      },
    });

    if (event.type !== "email.bounced" || !isPermanent(data.bounce?.type)) return;
    const to = Array.isArray(data.to) ? data.to[0] : data.to;
    if (!to) return;
    const stamp = await this.prisma.user.updateMany({
      where: { email: to.toLowerCase(), emailBouncedAt: null },
      data: { emailBouncedAt: eventTime(event), emailBounceReason: data.bounce?.message ?? data.bounce?.type ?? "unknown" },
    });
    if (stamp.count > 0) this.logger.log(`Marked ${stamp.count} user(s) as bounced`);
  }
}

/** Resend sends "Permanent" for hard bounces; a missing type is treated as one. */
function isPermanent(type: string | undefined): boolean {
  return !type || type.toLowerCase() === "permanent";
}

function eventTime(event: ResendWebhookEvent): Date {
  const parsed = event.created_at ? new Date(event.created_at) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}
