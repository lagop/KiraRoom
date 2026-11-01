import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { clientsWhoRefusedMarketing } from "../consent/marketing-consent";
import { escapeHtml } from '../common/html-escape';
import { EmailService } from '../notifications/services/email.service';
import { CampaignType } from './dto';
import { EmailSuppressionService } from './email-suppression.service';
import { EmailUnsubscribeService } from './email-unsubscribe.service';
import { EmailPacer } from './email-pacer';
import { campaignSender } from './email-campaign-sender.service';
import {
  plainTextPart,
  promotionUsable,
  subjectWithoutPromotion,
  withPreheader,
  withoutPromotion,
} from './campaign-content';

@Injectable()
export class EmailCampaignsScheduler {
  private readonly logger = new Logger(EmailCampaignsScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly suppressions: EmailSuppressionService,
    private readonly unsubscribes: EmailUnsubscribeService,
    private readonly pacer: EmailPacer,
  ) {}

  // Scheduled one-shot campaigns are started by EmailCampaignSender, which
  // sends every campaign in the background, in batches and at a pace.

  /**
   * Cleanup old campaign data
   * Runs daily to clean up analytics data older than 90 days
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupOldCampaignData() {
    this.logger.log('Cleaning up old campaign data...');

    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      // Delete old analytics
      const analyticsResult = await this.prisma.emailCampaignAnalytics.deleteMany({
        where: {
          createdAt: { lt: ninetyDaysAgo },
        },
      });

      this.logger.log(`Deleted ${analyticsResult.count} old campaign analytics records`);
    } catch (error) {
      this.logger.error(`Campaign cleanup job failed: ${error.message}`);
    }
  }

  /**
   * Re-engagement Campaigns Cron Job
   * Runs daily at 6 AM to send re-engagement emails to inactive clients
   * Finds clients who haven't visited in X days and sends them personalized emails
   */
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async processReengagementCampaigns() {
    this.logger.log('Processing re-engagement campaigns...');

    try {
      // Find all active re-engagement campaigns
      const campaigns = await this.prisma.emailCampaign.findMany({
        where: {
          campaignType: 'reengagement' as CampaignType,
          status: 'active', // Campaigns must be activated manually
        },
        include: {
          linkedPromotion: true,
          tenant: true,
        },
      });

      this.logger.log(`Found ${campaigns.length} active re-engagement campaigns`);

      let totalSent = 0;
      let totalErrors = 0;

      for (const campaign of campaigns) {
        try {
          const result = await this.processReengagementCampaign(campaign);
          totalSent += result.sent;
          totalErrors += result.errors;
        } catch (error) {
          totalErrors++;
          this.logger.error(`Failed to process re-engagement campaign ${campaign.id}: ${error.message}`);
        }
      }

      this.logger.log(`Re-engagement campaigns job completed: ${totalSent} sent, ${totalErrors} errors`);
    } catch (error) {
      this.logger.error(`Re-engagement campaigns job failed: ${error.message}`);
    }
  }

  /**
   * Process a single re-engagement campaign
   * Finds inactive clients and sends them personalized emails
   */
  private async processReengagementCampaign(campaign: any) {
    const inactiveDays = campaign.inactiveDaysThreshold || 30; // Default to 30 days
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - inactiveDays);

    // Find clients who:
    // 1. Are from the same tenant
    // 2. Came at least once (a completed visit) and not in the last X days.
    //    A client who never came is not one to win back: the owner's rule
    //    is that campaigns go only to clients with a completed visit. (A
    //    null lastVisit used to count as inactive, and since nothing filled
    //    it in, every client was.)
    // 3. Have an email address
    // 4. Haven't received a re-engagement email in the last 30 days
    const clients = await this.prisma.client.findMany({
      where: {
        tenantId: campaign.tenantId,
        email: { not: null },
        status: 'active',
        lastVisit: { lt: thresholdDate },
      },
    });

    // Not the ones emailed in the last 30 days, not the clients who said no to
    // promotions in their account, and not the addresses that hard-bounced or
    // complained. (The loop below used to walk `clients` instead of this
    // list, so the 30-day rule was computed and ignored.)
    const refused = await clientsWhoRefusedMarketing(this.prisma, campaign.tenantId);
    const suppressed = await this.suppressions.suppressedAmong(
      campaign.tenantId,
      clients.map((c) => c.email),
    );
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const eligibleClients = clients.filter(
      (client) =>
        !refused.has(client.id) &&
        !suppressed.has(String(client.email).toLowerCase()) &&
        (!client.lastReengagementSent || client.lastReengagementSent < thirtyDaysAgo),
    );

    this.logger.log(
      `Campaign ${campaign.id}: ${clients.length} inactive clients, ${eligibleClients.length} eligible`,
    );

    let sent = 0;
    let errors = 0;
    let newRecipients = 0;

    for (const client of eligibleClients) {
      try {
        // Build personalized email content
        const personalization = this.buildReengagementEmailContent(campaign, client);

        // Send the email, with the client's unsubscribe link (LSSI art. 21.2),
        // under the salon's name, replies to the salon, at the shared pace.
        const unsubscribe = this.unsubscribes.link({ kind: 'c', id: client.id });
        const withFooter = this.unsubscribes.withFooter(
          personalization.html,
          campaign.tenant?.name || 'el salón',
          unsubscribe.pageUrl,
        );
        const sender = campaignSender(campaign, campaign.tenant);
        await this.pacer.wait();
        const result = await this.emailService.sendEmail({
          to: client.email,
          subject: personalization.subject,
          html: withPreheader(withFooter, campaign.previewText),
          text: plainTextPart(withFooter),
          fromName: sender.fromName || undefined,
          replyTo: sender.replyTo,
          headers: unsubscribe.headers,
          tags: [
            { name: 'tenant_id', value: campaign.tenantId },
            { name: 'campaign_id', value: campaign.id },
          ],
        });

        if (result.success) {
          // Update client's lastReengagementSent date
          await this.prisma.client.update({
            where: { id: client.id },
            data: { lastReengagementSent: new Date() },
          });

          // The recipient row carries Resend's id, which is how delivery,
          // opens, clicks and bounces find their way back to this campaign.
          // A client is on a campaign's list once: a later re-engagement
          // email to her updates her row to the latest send.
          const key = { campaignId_clientId: { campaignId: campaign.id, clientId: client.id } };
          const row = {
            email: client.email,
            name: `${client.firstName} ${client.lastName}`,
            status: 'sent',
            sentAt: new Date(),
            messageId: result.id,
          };
          const existing = await this.prisma.emailCampaignRecipient.findUnique({ where: key, select: { id: true } });
          if (existing) {
            await this.prisma.emailCampaignRecipient.update({
              where: { id: existing.id },
              data: {
                ...row,
                deliveredAt: null,
                openedAt: null,
                clickedAt: null,
                bouncedAt: null,
                complainedAt: null,
                unsubscribedAt: null,
                errorMessage: null,
              },
            });
          } else {
            await this.prisma.emailCampaignRecipient.create({
              data: { campaignId: campaign.id, clientId: client.id, ...row },
            });
            newRecipients++;
          }

          sent++;
        } else {
          errors++;
          this.logger.warn(`Failed to send re-engagement email to client ${client.id}: ${result.error}`);
        }
      } catch (error) {
        errors++;
        this.logger.error(`Error sending re-engagement email to client ${client.id}: ${error.message}`);
      }
    }

    // Only what is known now: how many Resend accepted. Delivered and
    // bounced come from the webhook; a send that failed here never left, so
    // it is neither.
    if (sent > 0) {
      await this.prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: {
          totalRecipients: { increment: newRecipients },
          emailsSent: { increment: sent },
        },
      });
    }

    return { sent, errors };
  }

  /**
   * Build personalized email content for re-engagement
   */
  private buildReengagementEmailContent(campaign: any, client: any, now: Date = new Date()) {
    const values: Record<string, string> = {
      clientName: `${client.firstName ?? ''} ${client.lastName ?? ''}`.trim(),
      salonName: campaign.tenant?.name || 'el salón',
    };
    // The promotion's code only while it can still be used. A promotion
    // deleted (the link is then empty), switched off, used up or past its
    // end date drops the promotion block from the email: the client never
    // gets a code the salon will not honour, nor a literal {{discountCode}}.
    const promotion = campaign.linkedPromotion;
    let subject = String(campaign.subject ?? '');
    let content = String(campaign.content ?? '');
    if (promotionUsable(promotion, now)) {
      values.discountCode = String(promotion.code ?? '');
      values.discountValue = promotion.type === 'PERCENTAGE'
        ? `${Number(promotion.value)}%`
        : euros(Number(promotion.value));
    } else {
      subject = subjectWithoutPromotion(subject);
      content = withoutPromotion(content);
    }

    // The salon wrote the template; the values come from data (a client's
    // name from sign-up or an import), so in the HTML they are escaped. The
    // subject is plain text. A function replacer, so "$&" and the like in a
    // value are inserted as typed.
    const fill = (template: string, escape: boolean) =>
      String(template ?? '').replace(/{{(clientName|salonName|discountCode|discountValue)}}/g, (placeholder, key: string) =>
        key in values ? (escape ? escapeHtml(values[key]) : values[key]) : placeholder,
      );

    return { subject: fill(subject, false), html: fill(content, true) };
  }
}

/** 5 -> "5,00 €", as the client reads money. */
function euros(value: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number.isFinite(value) ? value : 0);
}
