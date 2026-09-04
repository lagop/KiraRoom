import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { EmailService } from '../notifications/services/email.service';
import { CampaignType } from './dto';

@Injectable()
export class EmailCampaignsScheduler {
  private readonly logger = new Logger(EmailCampaignsScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Scheduled Campaigns Cron Job
   * Runs every 5 minutes to process campaigns scheduled for future delivery
   * Uses Resend's scheduling feature to schedule emails directly with the provider
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async processScheduledCampaigns() {
    this.logger.log('Processing scheduled email campaigns...');

    try {
      // Find campaigns that are scheduled but not yet sent
      const now = new Date();
      
      const scheduledCampaigns = await this.prisma.emailCampaign.findMany({
        where: {
          status: 'scheduled',
          scheduledAt: {
            lte: now, // Scheduled time has passed
          },
        },
        include: {
          recipients: {
            where: {
              status: 'pending', // Only pending recipients
            },
          },
        },
      });

      this.logger.log(`Found ${scheduledCampaigns.length} scheduled campaigns ready to send`);

      let sentCount = 0;
      let errorCount = 0;

      for (const campaign of scheduledCampaigns) {
        try {
          await this.sendCampaign(campaign);
          sentCount++;
        } catch (error) {
          errorCount++;
          this.logger.error(`Failed to send scheduled campaign ${campaign.id}: ${error.message}`);
          
          // Update campaign status to failed
          await this.prisma.emailCampaign.update({
            where: { id: campaign.id },
            data: { status: 'failed' },
          });
        }
      }

      this.logger.log(`Scheduled campaigns job completed: ${sentCount} sent, ${errorCount} errors`);
    } catch (error) {
      this.logger.error(`Scheduled campaigns job failed: ${error.message}`);
    }
  }

  /**
   * Alternative: Schedule emails directly with Resend using their batch API
   * This approach schedules emails at the provider level
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduleWithResend() {
    this.logger.log('Scheduling campaigns with Resend batch API...');

    try {
      const now = new Date();
      const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);

      // Find campaigns that are scheduled and have recipients pending
      const campaignsToSchedule = await this.prisma.emailCampaign.findMany({
        where: {
          status: 'scheduled',
          scheduledAt: {
            gt: now, // Scheduled for future
            lte: tenMinutesFromNow, // Within next 10 minutes
          },
        },
        include: {
          recipients: {
            where: {
              status: 'pending',
            },
          },
        },
      });

      for (const campaign of campaignsToSchedule) {
        if (campaign.recipients.length === 0) continue;

        try {
          // Get the scheduled time
          const scheduledTime = campaign.scheduledAt;
          if (!scheduledTime) continue;

          // Prepare batch emails with scheduling
          const emails = campaign.recipients.map((recipient) => ({
            from: campaign.fromName 
              ? `${campaign.fromName} <${process.env.EMAIL_FROM || 'noreply@yourdomain.com'}>`
              : process.env.EMAIL_FROM || 'noreply@yourdomain.com',
            to: [recipient.email], // Resend batch expects array
            subject: campaign.subject,
            html: campaign.content,
            reply_to: campaign.replyTo,
            // Resend expects ISO 8601 format
            send_at: scheduledTime.toISOString(),
          }));

          // Send batch to Resend
          const result = await this.emailService.sendBatchEmails(emails);

          if (result.success) {
            // Update all recipients to scheduled status
            await this.prisma.emailCampaignRecipient.updateMany({
              where: {
                campaignId: campaign.id,
                status: 'pending',
              },
              data: {
                status: 'scheduled',
              },
            });

            this.logger.log(`Scheduled ${emails.length} emails for campaign ${campaign.id}`);
          }
        } catch (error) {
          this.logger.error(`Failed to schedule campaign ${campaign.id} with Resend: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Resend scheduling job failed: ${error.message}`);
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
   * Helper method to send a campaign
   */
  private async sendCampaign(campaign: any) {
    const recipients = campaign.recipients;
    
    if (recipients.length === 0) {
      this.logger.warn(`Campaign ${campaign.id} has no pending recipients`);
      
      // If no recipients, mark as sent anyway
      await this.prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { 
          status: 'sent',
          sentAt: new Date(),
        },
      });
      return;
    }

    let sentCount = 0;
    let failedCount = 0;

    // Send emails to all recipients
    for (const recipient of recipients) {
      try {
        const result = await this.emailService.sendEmail({
          to: recipient.email,
          subject: campaign.subject,
          html: campaign.content,
          replyTo: campaign.replyTo,
        });

        if (result.success) {
          await this.prisma.emailCampaignRecipient.update({
            where: { id: recipient.id },
            data: {
              status: 'sent',
              sentAt: new Date(),
              messageId: result.id,
            },
          });
          sentCount++;
        } else {
          await this.prisma.emailCampaignRecipient.update({
            where: { id: recipient.id },
            data: {
              status: 'bounced',
              bouncedAt: new Date(),
              errorMessage: result.error,
            },
          });
          failedCount++;
        }
      } catch (error) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: 'bounced',
            bouncedAt: new Date(),
            errorMessage: error.message,
          },
        });
        failedCount++;
      }
    }

    // Update campaign status and statistics
    await this.prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: {
        status: 'sent',
        sentAt: new Date(),
        emailsSent: { increment: sentCount + failedCount },
        emailsDelivered: { increment: sentCount },
        bounces: { increment: failedCount },
      },
    });

    this.logger.log(`Campaign ${campaign.id} sent: ${sentCount} delivered, ${failedCount} bounced`);
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

    // Filter out clients who received a re-engagement email recently
    const eligibleClients = clients.filter(client => {
      if (!client.lastReengagementSent) return true;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      return client.lastReengagementSent < thirtyDaysAgo;
    });

    this.logger.log(`Found ${clients.length} inactive clients for campaign ${campaign.id}`);

    let sent = 0;
    let errors = 0;

    for (const client of clients) {
      try {
        // Build personalized email content
        const personalization = this.buildReengagementEmailContent(campaign, client);

        // Send the email
        const result = await this.emailService.sendEmail({
          to: client.email,
          subject: personalization.subject,
          html: personalization.html,
          replyTo: campaign.replyTo,
        });

        if (result.success) {
          // Update client's lastReengagementSent date
          await this.prisma.client.update({
            where: { id: client.id },
            data: { lastReengagementSent: new Date() },
          });

          // Create recipient record
          await this.prisma.emailCampaignRecipient.create({
            data: {
              campaignId: campaign.id,
              clientId: client.id,
              email: client.email,
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

    // Update campaign statistics
    await this.prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: {
        emailsSent: { increment: sent },
        emailsDelivered: { increment: sent },
        bounces: { increment: errors },
      },
    });

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
