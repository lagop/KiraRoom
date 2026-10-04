import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { clientsWhoRefusedMarketing } from "../consent/marketing-consent";
import { EmailService } from '../notifications/services/email.service';
import { CampaignType } from './dto';
import { EmailCampaignsService } from './email-campaigns.service';
import { EmailSuppressionService } from './email-suppression.service';
import { EmailUnsubscribeService } from './email-unsubscribe.service';

@Injectable()
export class EmailCampaignsScheduler {
  private readonly logger = new Logger(EmailCampaignsScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly campaigns: EmailCampaignsService,
    private readonly suppressions: EmailSuppressionService,
    private readonly unsubscribes: EmailUnsubscribeService,
  ) {}

  /**
   * Scheduled Campaigns Cron Job
   * Runs every 5 minutes and sends the campaigns whose time has come.
   *
   * There used to be a second job that handed campaigns due in the next ten
   * minutes to Resend's batch API with a `send_at` field. The batch API has
   * no scheduling and the field name was wrong anyway, so those emails went
   * out up to ten minutes early, their Resend ids were thrown away (no
   * delivery, open or bounce could ever be matched back), and this job then
   * found no pending recipients and marked the campaign sent with zero
   * emails. One path now: up to five minutes late, fully tracked.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async processScheduledCampaigns() {
    try {
      const due = await this.prisma.emailCampaign.findMany({
        where: { status: 'scheduled', scheduledAt: { lte: new Date() } },
        select: { id: true, tenantId: true },
      });
      if (due.length === 0) return;
      if (!this.emailService.isConfigured()) {
        // Left scheduled, not failed: they go out once RESEND_API_KEY is set.
        this.logger.warn(`${due.length} scheduled campaign(s) due but email sending is not configured`);
        return;
      }

      for (const campaign of due) {
        try {
          await this.campaigns.deliverCampaign(campaign.tenantId, campaign.id, ['scheduled']);
        } catch (error) {
          this.logger.error(`Failed to send scheduled campaign ${campaign.id}: ${error.message}`);
          await this.prisma.emailCampaign.updateMany({
            where: { id: campaign.id, status: 'sending' },
            data: { status: 'failed' },
          });
        }
      }
    } catch (error) {
      this.logger.error(`Scheduled campaigns job failed: ${error.message}`);
    }
  }

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
    // 2. Have no visit in the last X days OR have never visited
    // 3. Have an email address
    // 4. Haven't received a re-engagement email in the last 30 days
    const clients = await this.prisma.client.findMany({
      where: {
        tenantId: campaign.tenantId,
        email: { not: null },
        status: 'active',
        OR: [
          { lastVisit: { lt: thresholdDate } },
          { lastVisit: null },
        ],
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

    for (const client of eligibleClients) {
      try {
        // Build personalized email content
        const personalization = this.buildReengagementEmailContent(campaign, client);

        // Send the email, with the client's unsubscribe link (LSSI art. 21.2)
        const unsubscribe = this.unsubscribes.link({ kind: 'c', id: client.id });
        const result = await this.emailService.sendEmail({
          to: client.email,
          subject: personalization.subject,
          html: this.unsubscribes.withFooter(
            personalization.html,
            campaign.tenant?.name || 'el salón',
            unsubscribe.pageUrl,
          ),
          replyTo: campaign.replyTo,
          headers: unsubscribe.headers,
        });

        if (result.success) {
          // Update client's lastReengagementSent date
          await this.prisma.client.update({
            where: { id: client.id },
            data: { lastReengagementSent: new Date() },
          });

          // The recipient row carries Resend's id, which is how delivery,
          // opens, clicks and bounces find their way back to this campaign.
          await this.prisma.emailCampaignRecipient.create({
            data: {
              campaignId: campaign.id,
              clientId: client.id,
              email: client.email,
              name: `${client.firstName} ${client.lastName}`,
              status: 'sent',
              sentAt: new Date(),
              messageId: result.id,
            },
          });

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
          totalRecipients: { increment: sent },
          emailsSent: { increment: sent },
        },
      });
    }

    return { sent, errors };
  }

  /**
   * Build personalized email content for re-engagement
   */
  private buildReengagementEmailContent(campaign: any, client: any) {
    const clientName = `${client.firstName} ${client.lastName}`;
    const salonName = campaign.tenant?.name || 'our salon';

    let subject = campaign.subject;
    let html = campaign.content;

    // Replace placeholders
    subject = subject.replace(/{{clientName}}/g, clientName);
    subject = subject.replace(/{{salonName}}/g, salonName);

    html = html.replace(/{{clientName}}/g, clientName);
    html = html.replace(/{{salonName}}/g, salonName);

    // If there's a linked promotion, add discount code
    if (campaign.linkedPromotion) {
      const discountCode = campaign.linkedPromotion.code;
      const discountValue = campaign.linkedPromotion.type === 'PERCENTAGE'
        ? `${campaign.linkedPromotion.value}%`
        : `€${campaign.linkedPromotion.value}`;

      html = html.replace(/{{discountCode}}/g, discountCode);
      html = html.replace(/{{discountValue}}/g, discountValue);

      // Also add to subject if placeholder exists
      subject = subject.replace(/{{discountCode}}/g, discountCode);
      subject = subject.replace(/{{discountValue}}/g, discountValue);
    }

    return { subject, html };
  }
}
