import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { EmailService } from "../notifications/services/email.service";
import { clientsWhoRefusedMarketing } from "../consent/marketing-consent";
import { EmailSuppressionService } from "./email-suppression.service";
import { EmailCampaignSender } from "./email-campaign-sender.service";
import { promotionUsable } from "./campaign-content";
import {
  CreateCampaignDto,
  UpdateCampaignDto,
  CreateTemplateDto,
  SendCampaignDto,
  CreateReengagementCampaignDto,
  CampaignType,
} from "./dto";

/** What a campaign's recipient list shows of each client. */
export const RECIPIENT_CLIENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  status: true,
} as const;

/** Why a client cannot receive the salon's email campaigns. */
export type ExclusionReason = "inactive" | "no_email" | "refused" | "suppressed" | "no_visit";

/** The salon's clients as the recipient picker sees them. */
export interface CampaignAudience {
  /** Clients who can be added to a campaign. */
  reachable: number;
  /** How many cannot, by reason (each client counted once, under her first reason). */
  excluded: Record<ExclusionReason, number>;
  /** The clients who cannot, with the reason, for the picker to mark them. */
  clients: Record<string, ExclusionReason>;
}

const NOT_CONFIGURED =
  "El envío de emails todavía no está configurado en KiraRoom. Escríbenos y lo revisamos.";
const NOT_FOUND = "Campaña no encontrada";
const REENGAGEMENT_ONE_SHOT =
  "Las campañas de reactivación se envían solas cada día, a quien lleva tiempo sin venir. Actívala en lugar de enviarla.";
const NO_RECIPIENTS =
  "La campaña no tiene destinatarias pendientes. Añade clientas antes de enviarla o programarla.";
const NOBODY_REACHABLE =
  "No hay clientas que puedan recibirla: hace falta email, al menos una visita completada y no haber rechazado las promociones.";

/** "" from a form field is "not given". */
const blankToNull = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
};

@Injectable()
export class EmailCampaignsService {
  private readonly logger = new Logger(EmailCampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly suppressions: EmailSuppressionService,
    private readonly sender: EmailCampaignSender,
  ) {}

  // ============ CAMPAIGNS ============

  /**
   * The salon's campaigns. Archived ones only with `archived` (the
   * "Archivadas" filter); the others without it. Each comes with how many of
   * its recipients are still to be sent and how many failed, for the card's
   * progress and its "Reintentar fallidos".
   */
  async getCampaigns(tenantId: string, status?: string, campaignType?: string, archived = false) {
    const where: any = { tenantId, archivedAt: archived ? { not: null } : null };
    if (status) {
      where.status = status;
    }
    if (campaignType) {
      where.campaignType = campaignType;
    }
    const campaigns = await this.prisma.emailCampaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { recipients: true },
        },
      },
    });
    if (campaigns.length === 0) return campaigns;

    const groups = await this.prisma.emailCampaignRecipient.groupBy({
      by: ["campaignId", "status"],
      where: { campaignId: { in: campaigns.map((c) => c.id) }, status: { in: ["pending", "sending", "failed"] } },
      _count: { _all: true },
    });
    const count = (campaignId: string, statuses: string[]) =>
      groups
        .filter((g) => g.campaignId === campaignId && statuses.includes(g.status))
        .reduce((sum, g) => sum + g._count._all, 0);
    return campaigns.map((c) => ({
      ...c,
      pendingCount: count(c.id, ["pending", "sending"]),
      failedCount: count(c.id, ["failed"]),
    }));
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
      throw new NotFoundException(NOT_FOUND);
    }
    return campaign;
  }

  async getCampaignRecipients(tenantId: string, campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
      include: {
        recipients: {
          // Who the client is, not her whole record: the password hash,
          // tokens and health fields have no business in a campaign list.
          include: {
            client: { select: RECIPIENT_CLIENT_SELECT },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!campaign) {
      throw new NotFoundException(NOT_FOUND);
    }
    return campaign.recipients;
  }

  async createCampaign(tenantId: string, dto: CreateCampaignDto) {
    if (dto.campaignType === CampaignType.reengagement) {
      throw new BadRequestException("Las campañas de reactivación se crean con el botón «Reactivación».");
    }
    return this.prisma.emailCampaign.create({
      data: {
        tenantId,
        name: dto.name,
        subject: dto.subject,
        previewText: blankToNull(dto.previewText),
        content: dto.content,
        campaignType: dto.campaignType,
        status: "draft",
        replyTo: blankToNull(dto.replyTo),
      },
    });
  }

  /** Only a draft can be edited: a scheduled one is first taken off the schedule. */
  async updateCampaign(
    tenantId: string,
    campaignId: string,
    dto: UpdateCampaignDto,
  ) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.status !== "draft") {
      throw new BadRequestException(
        campaign.status === "scheduled"
          ? "Desprográmala antes de editarla."
          : "Solo se pueden editar las campañas en borrador.",
      );
    }
    if (
      dto.campaignType !== undefined &&
      (dto.campaignType === CampaignType.reengagement) !== (campaign.campaignType === "reengagement")
    ) {
      throw new BadRequestException("Una campaña de reactivación no puede convertirse en otro tipo, ni al revés.");
    }

    return this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        name: dto.name,
        subject: dto.subject,
        ...(dto.previewText !== undefined ? { previewText: blankToNull(dto.previewText) } : {}),
        content: dto.content,
        campaignType: dto.campaignType,
        ...(dto.replyTo !== undefined ? { replyTo: blankToNull(dto.replyTo) } : {}),
        lastError: null,
      },
    });
  }

  /**
   * Deletes a campaign that never emailed anyone. One that did (sent, being
   * sent, or a re-engagement campaign that has run) is archived instead:
   * deleting it removed its recipient rows, and with them the unsubscribe
   * links already in the clients' inboxes ("Enlace no válido") and the
   * delivery history a late spam complaint is matched against.
   */
  async deleteCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.status === "sending") {
      throw new ConflictException("La campaña se está enviando: no se puede eliminar.");
    }
    if (campaign.status === "sent") {
      throw new ConflictException("Una campaña enviada no se puede eliminar: archívala para quitarla de la lista.");
    }
    if (campaign.status === "active") {
      throw new ConflictException("Desactiva la campaña antes de eliminarla.");
    }
    if (campaign.status === "scheduled") {
      throw new ConflictException("Desprográmala antes de eliminarla.");
    }
    const emailed = await this.prisma.emailCampaignRecipient.count({
      where: { campaignId, sentAt: { not: null } },
    });
    if (emailed > 0) {
      throw new ConflictException("Esta campaña ya envió emails: archívala en lugar de eliminarla.");
    }

    await this.prisma.emailCampaign.delete({
      where: { id: campaignId },
    });
    return { success: true };
  }

  /** Hides a campaign from the list, keeping its recipients and numbers. */
  async archiveCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.status === "sending" || campaign.status === "scheduled" || campaign.status === "active") {
      throw new BadRequestException(
        campaign.status === "sending"
          ? "La campaña se está enviando: espera a que termine para archivarla."
          : campaign.status === "scheduled"
            ? "Desprográmala antes de archivarla."
            : "Desactiva la campaña antes de archivarla.",
      );
    }
    return this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: { archivedAt: campaign.archivedAt ?? new Date() },
    });
  }

  async unarchiveCampaign(tenantId: string, campaignId: string) {
    await this.findCampaign(tenantId, campaignId);
    return this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: { archivedAt: null },
    });
  }

  async scheduleCampaign(
    tenantId: string,
    campaignId: string,
    scheduledAt: Date,
  ) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.campaignType === "reengagement") {
      throw new BadRequestException(REENGAGEMENT_ONE_SHOT);
    }
    if (campaign.status !== "draft") {
      throw new BadRequestException("Solo se pueden programar las campañas en borrador.");
    }
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException("Elige una fecha y hora que no hayan pasado.");
    }
    await this.assertPendingRecipients(campaignId);

    const claimed = await this.prisma.emailCampaign.updateMany({
      where: { id: campaignId, tenantId, status: "draft" },
      data: { status: "scheduled", scheduledAt, lastError: null },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Solo se pueden programar las campañas en borrador.");
    }
    return this.prisma.emailCampaign.findFirstOrThrow({ where: { id: campaignId, tenantId } });
  }

  /** "Desprogramar": a scheduled campaign goes back to draft, to edit it or send it another day. */
  async unscheduleCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.status !== "scheduled") {
      throw new BadRequestException("La campaña no está programada.");
    }
    // Claimed from "scheduled" only: if the dispatcher has just started
    // it, it is already sending and stays so.
    const claimed = await this.prisma.emailCampaign.updateMany({
      where: { id: campaignId, tenantId, status: "scheduled" },
      data: { status: "draft", scheduledAt: null },
    });
    if (claimed.count === 0) {
      throw new ConflictException("La campaña ya ha empezado a enviarse.");
    }
    return this.prisma.emailCampaign.findFirstOrThrow({ where: { id: campaignId, tenantId } });
  }

  /**
   * "Enviar ahora": claims the campaign (draft/scheduled -> sending) and
   * hands it to the background sender, which emails its pending recipients
   * in batches (EmailCampaignSender). The claim is atomic, so a double click
   * cannot send it twice. What happened to each email shows on the card as
   * it goes.
   */
  async sendCampaignNow(tenantId: string, campaignId: string) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.campaignType === "reengagement") {
      throw new BadRequestException(REENGAGEMENT_ONE_SHOT);
    }
    if (campaign.status !== "draft" && campaign.status !== "scheduled") {
      throw new BadRequestException("Esta campaña ya se ha enviado o se está enviando.");
    }
    if (!this.emailService.isConfigured()) {
      // Before, every send "failed" silently and the campaign still ended
      // up as sent. Say it instead, and leave the campaign as it was.
      throw new BadRequestException(NOT_CONFIGURED);
    }
    const pending = await this.assertPendingRecipients(campaignId);

    const claimed = await this.prisma.emailCampaign.updateMany({
      where: { id: campaignId, tenantId, status: { in: ["draft", "scheduled"] } },
      data: { status: "sending", lastError: null },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Esta campaña ya se ha enviado o se está enviando.");
    }
    this.sender.kick();
    return { success: true, queued: pending };
  }

  /**
   * "Enviar a todas": adds every client the campaign may reach (see
   * reachableClients) and sends it. The panel used to list all clients
   * itself, blocked and inactive ones included, and post their ids.
   */
  async sendToAllClients(tenantId: string, campaignId: string) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.campaignType === "reengagement") {
      throw new BadRequestException(REENGAGEMENT_ONE_SHOT);
    }
    if (campaign.status !== "draft" && campaign.status !== "scheduled") {
      throw new BadRequestException("Esta campaña ya se ha enviado o se está enviando.");
    }
    if (!this.emailService.isConfigured()) {
      throw new BadRequestException(NOT_CONFIGURED);
    }
    await this.addRecipients(tenantId, campaignId, "all");
    const pending = await this.prisma.emailCampaignRecipient.count({
      where: { campaignId, status: "pending" },
    });
    if (pending === 0) {
      throw new BadRequestException(NOBODY_REACHABLE);
    }
    return this.sendCampaignNow(tenantId, campaignId);
  }

  /**
   * "Reintentar fallidos": the recipients whose email could not be sent go
   * back in the queue with a fresh count of tries, and the campaign sends
   * again (only to them: everyone else keeps her status).
   */
  async retryFailed(tenantId: string, campaignId: string) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.status !== "sent") {
      throw new BadRequestException("Solo se pueden reintentar los envíos fallidos de una campaña ya enviada.");
    }
    if (!this.emailService.isConfigured()) {
      throw new BadRequestException(NOT_CONFIGURED);
    }
    const claimed = await this.prisma.emailCampaign.updateMany({
      where: { id: campaignId, tenantId, status: "sent" },
      data: { status: "sending", lastError: null },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("La campaña se está enviando.");
    }
    const reset = await this.prisma.emailCampaignRecipient.updateMany({
      where: { campaignId, status: "failed" },
      data: { status: "pending", attempts: 0, nextAttemptAt: null, errorMessage: null },
    });
    if (reset.count === 0) {
      await this.prisma.emailCampaign.updateMany({
        where: { id: campaignId, status: "sending" },
        data: { status: "sent" },
      });
      throw new BadRequestException("No hay envíos fallidos que reintentar.");
    }
    this.sender.kick();
    return { success: true, queued: reset.count };
  }

  /**
   * The salon's clients a campaign may reach: active, with an email, with
   * at least one completed visit (the owner's rule for every campaign: the
   * LSSI art. 21.2 exception covers clients with a prior relationship, and
   * a client who never came has none), not among those who said no to
   * promotions and not on the suppression list (unsubscribed, hard bounce,
   * spam complaint). Limited to `clientIds` when given (the panel's
   * selection), else all of them.
   */
  private async reachableClients(tenantId: string, clientIds?: string[]) {
    const refused = await clientsWhoRefusedMarketing(this.prisma, tenantId, clientIds);
    const clients = await this.prisma.client.findMany({
      where: {
        ...(clientIds ? { id: { in: clientIds } } : {}),
        tenantId,
        status: "active",
        email: { not: null },
        lastVisit: { not: null },
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    const suppressed = await this.suppressions.suppressedAmong(
      tenantId,
      clients.map((c) => c.email),
    );
    return clients
      .filter((c) => !refused.has(c.id) && !suppressed.has(String(c.email).toLowerCase()))
      .map((c) => ({
        clientId: c.id,
        email: c.email as string,
        name: `${c.firstName} ${c.lastName}`,
        status: "pending",
      }));
  }

  /**
   * Who of the salon's clients can receive campaigns, and why the others
   * cannot: what the recipient picker marks and counts.
   */
  async getAudience(tenantId: string): Promise<CampaignAudience> {
    const clients = await this.prisma.client.findMany({
      where: { tenantId },
      select: { id: true, email: true, status: true, lastVisit: true },
    });
    const refused = await clientsWhoRefusedMarketing(this.prisma, tenantId);
    const suppressed = await this.suppressions.suppressedAmong(
      tenantId,
      clients.map((c) => c.email),
    );
    const excluded: Record<ExclusionReason, number> = {
      inactive: 0,
      no_email: 0,
      refused: 0,
      suppressed: 0,
      no_visit: 0,
    };
    const reasons: Record<string, ExclusionReason> = {};
    let reachable = 0;
    for (const c of clients) {
      const reason: ExclusionReason | null =
        c.status !== "active"
          ? "inactive"
          : !c.email
            ? "no_email"
            : refused.has(c.id)
              ? "refused"
              : suppressed.has(c.email.toLowerCase())
                ? "suppressed"
                : !c.lastVisit
                  ? "no_visit"
                  : null;
      if (reason) {
        excluded[reason]++;
        reasons[c.id] = reason;
      } else {
        reachable++;
      }
    }
    return { reachable, excluded, clients: reasons };
  }

  /** What the panel needs to say honestly which numbers it can show. */
  async getTrackingStatus(tenantId: string) {
    return {
      sendingConfigured: this.emailService.isConfigured(),
      trackingConfigured: this.emailService.isTrackingConfigured(),
      suppressedAddresses: await this.suppressions.count(tenantId),
    };
  }

  /**
   * Adds these clients (or "all" of the salon's) to a campaign not yet sent.
   * Says how many were added and how many of those asked for could not be
   * (already on the list, or not reachable: see reachableClients).
   */
  async addRecipients(
    tenantId: string,
    campaignId: string,
    clientIds: string[] | "all",
  ) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.campaignType === "reengagement") {
      throw new BadRequestException(
        "Una campaña de reactivación elige sola a quién escribir: no se le añaden destinatarias.",
      );
    }
    if (campaign.status !== "draft" && campaign.status !== "scheduled") {
      throw new BadRequestException("Solo se pueden añadir destinatarias a una campaña que no se ha enviado.");
    }

    // A client already on the list is not added twice ("Enviar a todas"
    // after picking some, or a double click, emailed them twice).
    const asked = clientIds === "all" ? undefined : [...new Set(clientIds)];
    const reachable = await this.reachableClients(tenantId, asked);
    const recipients =
      reachable.length === 0
        ? []
        : await this.prisma.emailCampaignRecipient.createManyAndReturn({
            data: reachable.map((r) => ({ campaignId, ...r })),
            skipDuplicates: true,
          });

    // Update campaign total recipients count
    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        totalRecipients: {
          increment: recipients.length,
        },
      },
    });

    return {
      added: recipients.length,
      alreadyAdded: reachable.length - recipients.length,
      excluded: asked ? asked.length - reachable.length : 0,
    };
  }

  async removeRecipients(
    tenantId: string,
    campaignId: string,
    clientIds: string[],
  ) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.status !== "draft" && campaign.status !== "scheduled") {
      throw new BadRequestException("Solo se pueden quitar destinatarias de una campaña que no se ha enviado.");
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

  private async findCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!campaign) {
      throw new NotFoundException(NOT_FOUND);
    }
    return campaign;
  }

  /** Schedule and send need somebody to send to: "sent" to 0 people was a lie. */
  private async assertPendingRecipients(campaignId: string): Promise<number> {
    const pending = await this.prisma.emailCampaignRecipient.count({
      where: { campaignId, status: "pending" },
    });
    if (pending === 0) {
      throw new BadRequestException(NO_RECIPIENTS);
    }
    return pending;
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
      throw new NotFoundException("Plantilla no encontrada");
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
      throw new NotFoundException("Plantilla no encontrada");
    }

    await this.prisma.emailCampaignTemplate.delete({
      where: { id: templateId },
    });
    return { success: true };
  }

  // ============ ANALYTICS ============

  async getCampaignAnalytics(tenantId: string, campaignId: string) {
    const campaign = await this.findCampaign(tenantId, campaignId);

    const recentEvents = await this.prisma.emailCampaignAnalytics.findMany({
      where: { campaignId },
      orderBy: { timestamp: "desc" },
      take: 50,
    });

    // The counters are per recipient (ResendEventsService counts a
    // recipient's first click/bounce only), so they divide cleanly. Opens are
    // not measured (the owner's decision: no tracking pixel, LSSI art. 22.2),
    // so there is no open count or open rate.
    // There is no unsubscribe rate: campaigns have no unsubscribe link that
    // records anything, so that number would always be an invented 0.
    const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
    return {
      campaign,
      totalSent: campaign.emailsSent,
      totalDelivered: campaign.emailsDelivered,
      totalClicks: campaign.clicks,
      totalBounces: campaign.bounces,
      totalComplaints: campaign.complaints,
      clickRate: pct(campaign.clicks, campaign.emailsDelivered),
      bounceRate: pct(campaign.bounces, campaign.emailsSent),
      complaintRate: pct(campaign.complaints, campaign.emailsSent),
      recentEvents,
    };
  }

  // ============ BROADCAST TO ALL CLIENTS ============

  async broadcastToAllClients(tenantId: string, dto: SendCampaignDto) {
    if (dto.campaignType === CampaignType.reengagement) {
      throw new BadRequestException(REENGAGEMENT_ONE_SHOT);
    }
    if (dto.sendNow && !this.emailService.isConfigured()) {
      throw new BadRequestException(NOT_CONFIGURED);
    }

    const clients = await this.reachableClients(tenantId);

    if (clients.length === 0) {
      throw new BadRequestException(NOBODY_REACHABLE);
    }

    // Create campaign
    const campaign = await this.prisma.emailCampaign.create({
      data: {
        tenantId,
        name: dto.name,
        subject: dto.subject,
        previewText: blankToNull(dto.previewText),
        content: dto.content,
        campaignType: dto.campaignType,
        // Created as a draft either way: sendCampaignNow claims it from
        // draft. Creating it as "sending" made that call refuse it, so a
        // broadcast with sendNow never sent anything.
        status: "draft",
        replyTo: blankToNull(dto.replyTo),
        totalRecipients: clients.length,
      },
    });

    // Create recipients
    await this.prisma.emailCampaignRecipient.createMany({
      data: clients.map((r) => ({ campaignId: campaign.id, ...r })),
      skipDuplicates: true,
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
    const linkedPromotionId = blankToNull(dto.linkedPromotionId);
    if (linkedPromotionId) {
      const promotion = await this.prisma.promotion.findFirst({
        where: { id: linkedPromotionId, tenantId },
      });
      if (!promotion || !promotionUsable(promotion)) {
        throw new BadRequestException("La promoción no existe, está desactivada o ya ha terminado.");
      }
    }

    // Created as a draft: it starts sending when the salon activates it.
    const campaign = await this.prisma.emailCampaign.create({
      data: {
        tenantId,
        name: dto.name,
        subject: dto.subject,
        previewText: blankToNull(dto.previewText),
        content: dto.content,
        campaignType: "reengagement" as CampaignType,
        status: "draft",
        replyTo: blankToNull(dto.replyTo),
        inactiveDaysThreshold: dto.inactiveDaysThreshold,
        linkedPromotionId,
      },
      include: {
        linkedPromotion: true,
      },
    });

    return campaign;
  }

  async activateCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.campaignType !== "reengagement") {
      throw new BadRequestException("Solo se activan las campañas de reactivación.");
    }
    if (campaign.status !== "draft") {
      throw new BadRequestException("Solo se puede activar una campaña en borrador.");
    }
    if (campaign.archivedAt) {
      throw new BadRequestException("Desarchívala antes de activarla.");
    }

    return this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: { status: "active" },
    });
  }

  /**
   * Stops a re-engagement campaign. Only that, and only from active: it
   * used to move any campaign to draft, a sending one included, which then
   * could be sent again from the start.
   */
  async deactivateCampaign(tenantId: string, campaignId: string) {
    const campaign = await this.findCampaign(tenantId, campaignId);
    if (campaign.campaignType !== "reengagement" || campaign.status !== "active") {
      throw new BadRequestException("Solo se puede desactivar una campaña de reactivación activa.");
    }

    const claimed = await this.prisma.emailCampaign.updateMany({
      where: { id: campaignId, tenantId, status: "active", campaignType: "reengagement" },
      data: { status: "draft" },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Solo se puede desactivar una campaña de reactivación activa.");
    }
    return this.prisma.emailCampaign.findFirstOrThrow({ where: { id: campaignId, tenantId } });
  }
}
