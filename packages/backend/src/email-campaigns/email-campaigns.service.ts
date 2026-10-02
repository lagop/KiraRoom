import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../common/prisma/prisma.service";
import { EmailService } from "../notifications/services/email.service";
import { clientsWhoRefusedMarketing } from "../consent/marketing-consent";
import { EmailSuppressionService } from "./email-suppression.service";
import {
  CreateCampaignDto,
  UpdateCampaignDto,
  CreateTemplateDto,
  SendCampaignDto,
  CreateReengagementCampaignDto,
  CampaignType,
} from "./dto";

@Injectable()
export class EmailCampaignsService {
  private readonly logger = new Logger(EmailCampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly suppressions: EmailSuppressionService,
    private readonly config: ConfigService,
  ) {}

  // ============ CAMPAIGNS ============

  async getCampaigns(tenantId: string, status?: string, campaignType?: string) {
    const where: any = { tenantId };
    if (status) {
      where.status = status;
    }
    if (campaignType) {
      where.campaignType = campaignType;
    }
    return this.prisma.emailCampaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { recipients: true },
        },
      },
    });
  }

  async getCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
      include: {
        recipients: {
          orderBy: { createdAt: "desc" },
          take: 100,
        },
        _count: {
          select: { recipients: true },
        },
      },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    return campaign;
  }

  async getCampaignRecipients(tenantId: string, campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
      include: {
        recipients: {
          include: {
            client: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    return campaign.recipients;
  }

  async createCampaign(tenantId: string, dto: CreateCampaignDto) {
    return this.prisma.emailCampaign.create({
      data: {
        tenantId,
        name: dto.name,
        subject: dto.subject,
        previewText: dto.previewText,
        content: dto.content,
        campaignType: dto.campaignType,
        status: "draft",
        fromName: dto.fromName,
        replyTo: dto.replyTo,
      },
    });
  }

  async updateCampaign(
    tenantId: string,
    campaignId: string,
    dto: UpdateCampaignDto,
  ) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    if (campaign.status !== "draft") {
      throw new BadRequestException("Only draft campaigns can be updated");
    }

    return this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        name: dto.name,
        subject: dto.subject,
        previewText: dto.previewText,
        content: dto.content,
        campaignType: dto.campaignType,
        fromName: dto.fromName,
        replyTo: dto.replyTo,
      },
    });
  }

  async deleteCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    await this.prisma.emailCampaign.delete({
      where: { id: campaignId },
    });
    return { success: true };
  }

  async scheduleCampaign(
    tenantId: string,
    campaignId: string,
    scheduledAt: Date,
  ) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    if (campaign.status !== "draft") {
      throw new BadRequestException("Only draft campaigns can be scheduled");
    }

    return this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        status: "scheduled",
        scheduledAt,
      },
    });
  }

  async sendCampaignNow(tenantId: string, campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    if (campaign.status !== "draft" && campaign.status !== "scheduled") {
      throw new BadRequestException("Campaign cannot be sent");
    }
    if (!this.emailService.isConfigured()) {
      // Before, every send "failed" silently and the campaign still ended
      // up as sent. Say it instead, and leave the campaign as it was.
      throw new BadRequestException(
        "El envío de emails no está configurado en el servidor (falta RESEND_API_KEY).",
      );
    }
    return this.deliverCampaign(tenantId, campaignId, ["draft", "scheduled"]);
  }

  /**
   * Sends a campaign to its pending recipients. Shared by "send now" and
   * the scheduler.
   *
   * Claims the campaign first (status -> sending, only from `fromStatuses`)
   * so a second click or an overlapping scheduler run cannot send it twice.
   *
   * What it counts is only what it knows: an email Resend accepted is
   * "sent". Whether it was delivered, opened, clicked or bounced arrives
   * later through the Resend webhook (ResendEventsService), keyed by the id
   * Resend returned here -- which is why that id is stored, not a made-up
   * one. Addresses on the salon's suppression list (hard bounce, spam
   * complaint) are skipped.
   */
  async deliverCampaign(tenantId: string, campaignId: string, fromStatuses: string[]) {
    const claimed = await this.prisma.emailCampaign.updateMany({
      where: { id: campaignId, tenantId, status: { in: fromStatuses as any } },
      data: { status: "sending" },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Campaign cannot be sent");
    }

    const campaign = await this.prisma.emailCampaign.findFirstOrThrow({
      where: { id: campaignId, tenantId },
      include: { recipients: { where: { status: "pending" } } },
    });
    const suppressed = await this.suppressions.suppressedAmong(
      tenantId,
      campaign.recipients.map((r) => r.email),
    );

    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let suppressedCount = 0;

    // Checked at send time, not only when recipients were added: a client
    // can say no in their account in between.
    const refused = await clientsWhoRefusedMarketing(
      this.prisma,
      tenantId,
      campaign.recipients.map((r) => r.clientId).filter((id): id is string => !!id),
    );

    for (const recipient of campaign.recipients) {
      if (recipient.clientId && refused.has(recipient.clientId)) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "unsubscribed", unsubscribedAt: new Date() },
        });
        skippedCount++;
        continue;
      }
      if (suppressed.has(recipient.email.toLowerCase())) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "suppressed",
            errorMessage: "Dirección dada de baja: rebote permanente o queja de spam",
          },
        });
        suppressedCount++;
        continue;
      }

      const result = await this.emailService.sendEmail({
        to: recipient.email,
        subject: campaign.subject,
        html: campaign.content,
        replyTo: campaign.replyTo ?? undefined,
      });

      if (result.success) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "sent", sentAt: new Date(), messageId: result.id ?? null },
        });
        sentCount++;
      } else {
        // Refused before leaving (bad address, provider error): a failure,
        // not a bounce -- the panel's bounces are the receiving server's.
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "failed", errorMessage: result.error?.slice(0, 500) ?? "Error" },
        });
        failedCount++;
      }
    }

    // Increment, never overwrite: delivery events for the first emails may
    // already be arriving while the loop runs.
    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        status: "sent",
        sentAt: new Date(),
        emailsSent: { increment: sentCount },
      },
    });

    this.logger.log(
      `Campaign ${campaignId}: ${sentCount} sent, ${failedCount} failed, ${suppressedCount} suppressed, ${skippedCount} refused marketing`,
    );
    return { success: true, sentCount, failedCount, suppressedCount, skippedCount };
  }

  /** What the panel needs to say honestly which numbers it can show. */
  async getTrackingStatus(tenantId: string) {
    return {
      sendingConfigured: this.emailService.isConfigured(),
      trackingConfigured: !!this.config.get<string>("RESEND_WEBHOOK_SECRET"),
      suppressedAddresses: await this.suppressions.count(tenantId),
    };
  }

  async addRecipients(
    tenantId: string,
    campaignId: string,
    clientIds: string[],
  ) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    if (campaign.status === "sent" || campaign.status === "sending") {
      throw new BadRequestException("Cannot add recipients to sent campaigns");
    }

    // Get client emails. Those who said no to promotions are left out.
    const refused = await clientsWhoRefusedMarketing(this.prisma, tenantId, clientIds);
    const clients = (
      await this.prisma.client.findMany({
        where: {
          id: { in: clientIds },
          tenantId,
          email: { not: null },
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      })
    ).filter((c) => !refused.has(c.id));

    // Create recipients
    const recipients = await Promise.all(
      clients.map((client) =>
        this.prisma.emailCampaignRecipient.create({
          data: {
            campaignId,
            clientId: client.id,
            email: client.email,
            name: `${client.firstName} ${client.lastName}`,
            status: "pending",
          },
        }),
      ),
    );

    // Update campaign total recipients count
    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        totalRecipients: {
          increment: recipients.length,
        },
      },
    });

    return recipients;
  }

  async removeRecipients(
    tenantId: string,
    campaignId: string,
    clientIds: string[],
  ) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    if (campaign.status === "sent" || campaign.status === "sending") {
      throw new BadRequestException(
        "Cannot remove recipients from sent campaigns",
      );
    }

    // Delete recipients for the specified clients
    const deleteResult = await this.prisma.emailCampaignRecipient.deleteMany({
      where: {
        campaignId,
        clientId: { in: clientIds },
        status: "pending", // Only remove pending recipients
      },
    });

    // Update campaign total recipients count
    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        totalRecipients: {
          decrement: deleteResult.count,
        },
      },
    });

    return { removed: deleteResult.count };
  }

  // ============ TEMPLATES ============

  async getTemplates(tenantId: string) {
    return this.prisma.emailCampaignTemplate.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
    });
  }

  async getTemplate(tenantId: string, templateId: string) {
    const template = await this.prisma.emailCampaignTemplate.findFirst({
      where: { id: templateId, tenantId },
    });
    if (!template) {
      throw new NotFoundException("Template not found");
    }
    return template;
  }

  async createTemplate(tenantId: string, dto: CreateTemplateDto) {
    // If setting as default, unset other defaults
    if (dto.isDefault) {
      await this.prisma.emailCampaignTemplate.updateMany({
        where: { tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return this.prisma.emailCampaignTemplate.create({
      data: {
        tenantId,
        name: dto.name,
        subject: dto.subject,
        previewText: dto.previewText,
        content: dto.content,
        campaignType: dto.campaignType,
        isDefault: dto.isDefault || false,
      },
    });
  }

  async deleteTemplate(tenantId: string, templateId: string) {
    const template = await this.prisma.emailCampaignTemplate.findFirst({
      where: { id: templateId, tenantId },
    });
    if (!template) {
      throw new NotFoundException("Template not found");
    }

    await this.prisma.emailCampaignTemplate.delete({
      where: { id: templateId },
    });
    return { success: true };
  }

  // ============ ANALYTICS ============

  async getCampaignAnalytics(tenantId: string, campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    const recentEvents = await this.prisma.emailCampaignAnalytics.findMany({
      where: { campaignId },
      orderBy: { timestamp: "desc" },
      take: 50,
    });

    // The counters are per recipient (ResendEventsService counts a
    // recipient's first open/click/bounce only), so they divide cleanly.
    // There is no unsubscribe rate: campaigns have no unsubscribe link that
    // records anything, so that number would always be an invented 0.
    const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
    return {
      campaign,
      totalSent: campaign.emailsSent,
      totalDelivered: campaign.emailsDelivered,
      totalOpened: campaign.emailsOpened,
      totalClicks: campaign.clicks,
      totalBounces: campaign.bounces,
      totalComplaints: campaign.complaints,
      openRate: pct(campaign.emailsOpened, campaign.emailsDelivered),
      clickRate: pct(campaign.clicks, campaign.emailsDelivered),
      bounceRate: pct(campaign.bounces, campaign.emailsSent),
      complaintRate: pct(campaign.complaints, campaign.emailsSent),
      recentEvents,
    };
  }

  // ============ BROADCAST TO ALL CLIENTS ============

  async broadcastToAllClients(tenantId: string, dto: SendCampaignDto) {
    if (dto.sendNow && !this.emailService.isConfigured()) {
      throw new BadRequestException(
        "El envío de emails no está configurado en el servidor (falta RESEND_API_KEY).",
      );
    }

    // Get all active clients with email, except who said no to promotions
    const refused = await clientsWhoRefusedMarketing(this.prisma, tenantId);
    const clients = (
      await this.prisma.client.findMany({
        where: {
          tenantId,
          status: "active",
          email: { not: null },
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      })
    ).filter((c) => !refused.has(c.id));

    if (clients.length === 0) {
      throw new BadRequestException("No clients with email addresses found");
    }

    // Create campaign
    const campaign = await this.prisma.emailCampaign.create({
      data: {
        tenantId,
        name: dto.name,
        subject: dto.subject,
        previewText: dto.previewText,
        content: dto.content,
        campaignType: dto.campaignType,
        // Created as a draft either way: sendCampaignNow claims it from
        // draft. Creating it as "sending" made that call refuse it, so a
        // broadcast with sendNow never sent anything.
        status: "draft",
        fromName: dto.fromName,
        replyTo: dto.replyTo,
        totalRecipients: clients.length,
      },
    });

    // Create recipients
    await this.prisma.emailCampaignRecipient.createMany({
      data: clients.map((client) => ({
        campaignId: campaign.id,
        clientId: client.id,
        email: client.email,
        name: `${client.firstName} ${client.lastName}`,
        status: "pending",
      })),
    });

    // Send immediately if requested
    if (dto.sendNow) {
      return this.sendCampaignNow(tenantId, campaign.id);
    }

    return campaign;
  }

  // ============ RE-ENGAGEMENT CAMPAIGNS ============

  async createReengagementCampaign(
    tenantId: string,
    dto: CreateReengagementCampaignDto,
  ) {
    // Validate promotion if provided
    if (dto.linkedPromotionId) {
      const promotion = await this.prisma.promotion.findFirst({
        where: { id: dto.linkedPromotionId, tenantId, isActive: true },
      });
      if (!promotion) {
        throw new BadRequestException("Promotion not found or inactive");
      }
    }

    // Create the re-engagement campaign as inactive (needs manual activation)
    const campaign = await this.prisma.emailCampaign.create({
      data: {
        tenantId,
        name: dto.name,
        subject: dto.subject,
        previewText: dto.previewText,
        content: dto.content,
        campaignType: "reengagement" as CampaignType,
        status: "draft", // Will be activated separately
        fromName: dto.fromName,
        replyTo: dto.replyTo,
        inactiveDaysThreshold: dto.inactiveDaysThreshold,
        linkedPromotionId: dto.linkedPromotionId,
      },
      include: {
        linkedPromotion: true,
      },
    });

    return campaign;
  }

  async activateCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    if (campaign.campaignType !== "reengagement") {
      throw new BadRequestException(
        "Only re-engagement campaigns can be activated",
      );
    }
    if (campaign.status !== "draft") {
      throw new BadRequestException("Only draft campaigns can be activated");
    }

    return this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: { status: "active" },
    });
  }

  async deactivateCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    return this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: { status: "draft" },
    });
  }
}
