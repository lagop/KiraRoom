import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { EmailService } from "../notifications/services/email.service";
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
      include: {
        recipients: true,
      },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    if (campaign.status !== "draft" && campaign.status !== "scheduled") {
      throw new BadRequestException("Campaign cannot be sent");
    }

    // Update status to sending
    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: { status: "sending" },
    });

    // Send emails to all recipients
    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of campaign.recipients) {
      try {
        await this.emailService.sendEmail({
          to: recipient.email,
          subject: campaign.subject,
          html: campaign.content,
          replyTo: campaign.replyTo,
        });

        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "sent",
            sentAt: new Date(),
            messageId: `campaign_${campaignId}_${recipient.id}`,
          },
        });
        sentCount++;
      } catch (error) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "bounced",
            bouncedAt: new Date(),
            errorMessage: error.message,
          },
        });
        failedCount++;
      }
    }

    // Update campaign status and stats
    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        status: "sent",
        sentAt: new Date(),
        emailsSent: sentCount,
        emailsDelivered: sentCount - failedCount,
        bounces: failedCount,
      },
    });

    return { success: true, sentCount, failedCount };
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

    // Get client emails
    const clients = await this.prisma.client.findMany({
      where: {
        id: { in: clientIds },
        tenantId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
      },
    });

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

    const analytics = await this.prisma.emailCampaignAnalytics.findMany({
      where: { campaignId },
      orderBy: { timestamp: "desc" },
    });

    // Calculate metrics
    const opened = analytics.filter((a) => a.eventType === "opened").length;
    const clicked = analytics.filter((a) => a.eventType === "clicked").length;
    const bounced = analytics.filter((a) => a.eventType === "bounced").length;
    const unsubscribed = analytics.filter(
      (a) => a.eventType === "unsubscribed",
    ).length;

    return {
      campaign,
      totalSent: campaign.emailsSent,
      totalDelivered: campaign.emailsDelivered,
      totalOpened: campaign.emailsOpened,
      totalClicks: campaign.clicks,
      openRate:
        campaign.emailsDelivered > 0
          ? (campaign.emailsOpened / campaign.emailsDelivered) * 100
          : 0,
      clickRate:
        campaign.emailsOpened > 0
          ? (campaign.clicks / campaign.emailsOpened) * 100
          : 0,
      bounceRate:
        campaign.emailsSent > 0
          ? (campaign.bounces / campaign.emailsSent) * 100
          : 0,
      unsubscribeRate:
        campaign.emailsSent > 0
          ? (unsubscribed / campaign.emailsSent) * 100
          : 0,
      recentEvents: analytics.slice(0, 50),
    };
  }

  // ============ BROADCAST TO ALL CLIENTS ============

  async broadcastToAllClients(tenantId: string, dto: SendCampaignDto) {
    // Get all active clients with email
    const clients = await this.prisma.client.findMany({
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
    });

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
        status: dto.sendNow ? "sending" : "draft",
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
