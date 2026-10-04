import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma, WhatsAppCampaignStatus, WhatsAppRecipientStatus } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { clientsWhoAcceptedWhatsAppMarketing } from "../../consent/marketing-consent";
import { WhatsAppTemplateService } from "../whatsapp-template.service";
import { templateParam } from "../whatsapp-templates";
import {
  attemptOf,
  campaignTemplatePayload,
  compileBody,
  templateNameFor,
  withinSendingHours,
} from "./campaign-template";

export interface CampaignInput {
  name: string;
  body: string;
  /** Only clients with no visit in this many days (re-engagement); none = all. */
  inactiveDays?: number | null;
  /** When to send; none = as soon as Meta approves the message. */
  scheduledAt?: Date | null;
}

export interface AudiencePreview {
  /** Clients who would get it now. */
  eligible: number;
  /** Active clients with a phone who match the filter but never opted in. */
  withoutConsent: number;
  /** Active clients with no phone. */
  withoutPhone: number;
}

/** Sends per campaign per dispatcher run (once a minute). */
const BATCH = 50;
/** Meta's "too many messages" codes: stop the batch, retry next minute. */
const RATE_LIMIT_CODES = new Set(["meta_4", "meta_80007", "meta_130429", "meta_131056"]);
const EDITABLE: WhatsAppCampaignStatus[] = [WhatsAppCampaignStatus.draft];

/**
 * WhatsApp promotions from the salon's own number.
 *
 * Draft -> "Enviar a revisión": the text goes to Meta as a MARKETING
 * template on the salon's WhatsApp Business account and the campaign is
 * scheduled. The dispatcher then, every minute: reads Meta's verdict
 * (rejected -> back to draft with Meta's reason), starts approved campaigns
 * whose time has come, and sends in batches.
 *
 * Messages only go out from 9:00 to 21:00 in the salon's time zone; a
 * campaign approved at night waits for the morning.
 *
 * The audience is worked out when sending starts and again for every batch:
 * only clients who opted in to WhatsApp promotions and did not withdraw
 * (marketing-consent.ts). Meta bills marketing conversations to the salon's
 * own WhatsApp Business account; KiraRoom is not in that money path.
 */
@Injectable()
export class WhatsAppCampaignsService {
  private readonly logger = new Logger(WhatsAppCampaignsService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: WhatsAppTemplateService,
  ) {}

  // ─── Panel ────────────────────────────────────────────────────────────

  list(tenantId: string) {
    return this.prisma.whatsAppCampaign.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async get(tenantId: string, id: string) {
    const campaign = await this.find(tenantId, id);
    const groups = await this.prisma.whatsAppCampaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId: id },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const g of groups) byStatus[g.status] = g._count._all;
    return { ...campaign, byStatus };
  }

  async create(tenantId: string, userId: string, input: CampaignInput) {
    this.assertBody(input.body);
    return this.prisma.whatsAppCampaign.create({
      data: {
        tenantId,
        createdById: userId,
        name: input.name.trim(),
        body: input.body.trim(),
        templateId: "",
        segmentFilter: segmentOf(input),
        scheduledAt: input.scheduledAt ?? null,
        status: WhatsAppCampaignStatus.draft,
      },
    });
  }

  async update(tenantId: string, id: string, input: Partial<CampaignInput>) {
    const campaign = await this.find(tenantId, id);
    if (!EDITABLE.includes(campaign.status)) {
      throw new ConflictException("Solo se puede editar una campaña en borrador.");
    }
    if (input.body !== undefined) this.assertBody(input.body);
    return this.prisma.whatsAppCampaign.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.body !== undefined ? { body: input.body.trim() } : {}),
        ...(input.inactiveDays !== undefined ? { segmentFilter: segmentOf(input) } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const campaign = await this.find(tenantId, id);
    if (campaign.status === WhatsAppCampaignStatus.sending) {
      throw new ConflictException("La campaña se está enviando: cancélala primero.");
    }
    await this.prisma.whatsAppCampaign.delete({ where: { id } });
    return { deleted: true };
  }

  /** Stops a scheduled or sending campaign; what was sent stays sent. */
  async cancel(tenantId: string, id: string) {
    const campaign = await this.find(tenantId, id);
    const cancellable: WhatsAppCampaignStatus[] = [
      WhatsAppCampaignStatus.scheduled,
      WhatsAppCampaignStatus.sending,
    ];
    if (!cancellable.includes(campaign.status)) {
      throw new ConflictException("Esta campaña no está programada ni enviándose.");
    }
    return this.prisma.whatsAppCampaign.update({
      where: { id },
      data: { status: WhatsAppCampaignStatus.cancelled, completedAt: new Date() },
    });
  }

  /** Who would receive a campaign with this filter, now. */
  async audiencePreview(tenantId: string, inactiveDays?: number | null): Promise<AudiencePreview> {
    const base: Prisma.ClientWhereInput = { tenantId, status: "active", ...inactiveFilter(inactiveDays) };
    const [withPhone, withoutPhone] = await Promise.all([
      this.prisma.client.findMany({
        where: { ...base, phone: { not: null } },
        select: { id: true, phone: true, communicationPreferences: true },
      }),
      this.prisma.client.count({ where: { AND: [base, { OR: [{ phone: null }, { phone: "" }] }] } }),
    ]);
    const eligible = await this.eligibleAmong(tenantId, withPhone);
    return {
      eligible: eligible.length,
      withoutConsent: withPhone.filter((c) => c.phone).length - eligible.length,
      withoutPhone,
    };
  }

  /**
   * Sends the text to Meta for review and schedules the campaign. Needs the
   * salon's WhatsApp connected. A campaign rejected by Meta is resubmitted
   * under a new template name.
   */
  async submit(tenantId: string, id: string) {
    const campaign = await this.find(tenantId, id);
    if (!EDITABLE.includes(campaign.status)) {
      throw new ConflictException("Esta campaña ya está enviada a revisión.");
    }
    if (campaign.scheduledAt && campaign.scheduledAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException("La fecha de envío ya ha pasado: cámbiala o quítala.");
    }
    const body = this.assertBody(campaign.body);
    const name = templateNameFor(campaign.id, attemptOf(campaign.templateId) + 1);
    const result = await this.templates.createTemplate(tenantId, campaignTemplatePayload(name, body));
    if ("error" in result) {
      throw new BadRequestException(
        result.error === "not_connected"
          ? "Conecta el WhatsApp del salón (Ajustes → WhatsApp) antes de enviar campañas."
          : `Meta no ha aceptado el mensaje: ${result.error}`,
      );
    }
    return this.prisma.whatsAppCampaign.update({
      where: { id },
      data: {
        templateId: name,
        templateStatus: result.status,
        templateReason: null,
        lastError: null,
        submittedAt: new Date(),
        status: WhatsAppCampaignStatus.scheduled,
      },
    });
  }

  // ─── Dispatcher ───────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async dispatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.checkReviews();
      await this.startDue();
      await this.sendBatches();
    } catch (err) {
      this.logger.error(`WhatsApp campaign dispatcher failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Meta's verdict on the templates waiting for it. */
  async checkReviews(): Promise<void> {
    const waiting = await this.prisma.whatsAppCampaign.findMany({
      where: { status: WhatsAppCampaignStatus.scheduled, templateStatus: { not: "APPROVED" } },
      select: { id: true, tenantId: true, templateId: true },
      take: 50,
    });
    for (const c of waiting) {
      try {
        const review = await this.templates.templateReview(c.tenantId, c.templateId);
        if (!review) continue;
        if (review.status === "REJECTED") {
          await this.prisma.whatsAppCampaign.update({
            where: { id: c.id },
            data: {
              status: WhatsAppCampaignStatus.draft,
              templateStatus: "REJECTED",
              templateReason: review.reason ?? null,
            },
          });
          this.logger.log(`WhatsApp campaign ${c.id}: Meta rejected the template (${review.reason ?? "no reason"})`);
        } else {
          await this.prisma.whatsAppCampaign.update({
            where: { id: c.id },
            data: { templateStatus: review.status },
          });
        }
      } catch (err) {
        this.logger.warn(`WhatsApp campaign ${c.id}: review check failed: ${(err as Error).message}`);
      }
    }
  }

  /** Approved campaigns whose time has come: work out the audience, start. */
  async startDue(now = new Date()): Promise<void> {
    const due = await this.prisma.whatsAppCampaign.findMany({
      where: {
        status: WhatsAppCampaignStatus.scheduled,
        templateStatus: "APPROVED",
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
      },
      include: { tenant: { select: { timezone: true } } },
      take: 20,
    });
    for (const campaign of due) {
      if (!withinSendingHours(now, campaign.tenant?.timezone ?? "Europe/Madrid")) continue;
      // Claimed first: a second instance or run does not start it twice.
      const claimed = await this.prisma.whatsAppCampaign.updateMany({
        where: { id: campaign.id, status: WhatsAppCampaignStatus.scheduled },
        data: { status: WhatsAppCampaignStatus.sending, startedAt: now },
      });
      if (claimed.count === 0) continue;

      const inactiveDays = (campaign.segmentFilter as { inactiveDays?: number } | null)?.inactiveDays ?? null;
      const candidates = await this.prisma.client.findMany({
        where: { tenantId: campaign.tenantId, status: "active", phone: { not: null }, ...inactiveFilter(inactiveDays, now) },
        select: { id: true, phone: true, communicationPreferences: true },
      });
      const audience = await this.eligibleAmong(campaign.tenantId, candidates);
      if (audience.length > 0) {
        await this.prisma.whatsAppCampaignRecipient.createMany({
          data: audience.map((c) => ({ campaignId: campaign.id, clientId: c.id, phone: c.phone! })),
          skipDuplicates: true,
        });
      }
      await this.prisma.whatsAppCampaign.update({
        where: { id: campaign.id },
        data: {
          totalRecipients: audience.length,
          ...(audience.length === 0
            ? {
                status: WhatsAppCampaignStatus.completed,
                completedAt: now,
                lastError: "Ningún cliente había aceptado recibir promociones por WhatsApp.",
              }
            : {}),
        },
      });
      this.logger.log(`WhatsApp campaign ${campaign.id}: started for ${audience.length} clients`);
    }
  }

  /** One batch per sending campaign; finishes the ones with nobody left. */
  async sendBatches(now = new Date()): Promise<void> {
    const sending = await this.prisma.whatsAppCampaign.findMany({
      where: { status: WhatsAppCampaignStatus.sending },
      include: { tenant: { select: { country: true, timezone: true } } },
      take: 20,
    });
    for (const campaign of sending) {
      // A batch interrupted at 21:00 carries on the next morning.
      if (!withinSendingHours(now, campaign.tenant?.timezone ?? "Europe/Madrid")) continue;
      const pending = await this.prisma.whatsAppCampaignRecipient.findMany({
        where: { campaignId: campaign.id, status: WhatsAppRecipientStatus.pending },
        take: BATCH,
        orderBy: { createdAt: "asc" },
      });
      if (pending.length === 0) {
        await this.finish(campaign.id);
        continue;
      }

      // Consent is checked again per batch: a client may have answered BAJA
      // to another campaign or withdrawn in their account since the start.
      const clientIds = pending.map((r) => r.clientId).filter((id): id is string => !!id);
      const [accepted, clients] = await Promise.all([
        clientsWhoAcceptedWhatsAppMarketing(this.prisma, campaign.tenantId, clientIds),
        this.prisma.client.findMany({
          where: { id: { in: clientIds }, tenantId: campaign.tenantId },
          select: { id: true, firstName: true, status: true, communicationPreferences: true },
        }),
      ]);
      const byId = new Map(clients.map((c) => [c.id, c]));

      for (const recipient of pending) {
        const client = recipient.clientId ? byId.get(recipient.clientId) : undefined;
        if (!client || !accepted.has(client.id) || whatsappOff(client.communicationPreferences)) {
          await this.prisma.whatsAppCampaignRecipient.update({
            where: { id: recipient.id },
            data: { status: WhatsAppRecipientStatus.opted_out },
          });
          continue;
        }
        const values = campaign.body.match(/\{\{\s*nombre\s*\}\}/i)
          ? [templateParam(client.firstName, "cliente")]
          : [];
        const result = await this.templates.sendApprovedTemplate(
          campaign.tenantId,
          { name: campaign.templateId, language: "es" },
          recipient.phone,
          campaign.tenant?.country ?? undefined,
          values,
        );
        if (result.sent) {
          await this.prisma.whatsAppCampaignRecipient.update({
            where: { id: recipient.id },
            data: { status: WhatsAppRecipientStatus.sent, sentAt: new Date(), messageId: result.messageId ?? null },
          });
          continue;
        }
        if (result.reason === "not_connected") {
          await this.prisma.whatsAppCampaign.update({
            where: { id: campaign.id },
            data: {
              status: WhatsAppCampaignStatus.failed,
              completedAt: new Date(),
              lastError: "El WhatsApp del salón se desconectó durante el envío.",
            },
          });
          break;
        }
        if (result.reason && RATE_LIMIT_CODES.has(result.reason)) {
          // Left pending: the next run continues where this one stopped.
          this.logger.warn(`WhatsApp campaign ${campaign.id}: Meta rate limit, pausing until next run`);
          break;
        }
        await this.prisma.whatsAppCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: WhatsAppRecipientStatus.failed, externalError: result.reason ?? "error" },
        });
      }
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async finish(campaignId: string) {
    const groups = await this.prisma.whatsAppCampaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId },
      _count: { _all: true },
    });
    const count = (s: WhatsAppRecipientStatus) => groups.find((g) => g.status === s)?._count._all ?? 0;
    await this.prisma.whatsAppCampaign.updateMany({
      where: { id: campaignId, status: WhatsAppCampaignStatus.sending },
      data: {
        status: WhatsAppCampaignStatus.completed,
        completedAt: new Date(),
        sent:
          count(WhatsAppRecipientStatus.sent) +
          count(WhatsAppRecipientStatus.delivered) +
          count(WhatsAppRecipientStatus.read),
        delivered: count(WhatsAppRecipientStatus.delivered) + count(WhatsAppRecipientStatus.read),
        read: count(WhatsAppRecipientStatus.read),
        failed: count(WhatsAppRecipientStatus.failed),
        optedOut: count(WhatsAppRecipientStatus.opted_out),
      },
    });
  }

  /** The clients among these who may receive WhatsApp promotions now. */
  private async eligibleAmong<T extends { id: string; phone: string | null; communicationPreferences: unknown }>(
    tenantId: string,
    clients: T[],
  ): Promise<T[]> {
    const withPhone = clients.filter((c) => !!c.phone && !whatsappOff(c.communicationPreferences));
    if (withPhone.length === 0) return [];
    const accepted = await clientsWhoAcceptedWhatsAppMarketing(
      this.prisma,
      tenantId,
      withPhone.map((c) => c.id),
    );
    return withPhone.filter((c) => accepted.has(c.id));
  }

  private assertBody(raw: string) {
    const compiled = compileBody(raw);
    if ("error" in compiled) throw new BadRequestException(compiled.error);
    return compiled;
  }

  private async find(tenantId: string, id: string) {
    const campaign = await this.prisma.whatsAppCampaign.findFirst({ where: { id, tenantId } });
    if (!campaign) throw new NotFoundException("Campaña no encontrada");
    return campaign;
  }
}

/** The client turned WhatsApp off as a channel (or answered BAJA). */
function whatsappOff(prefs: unknown): boolean {
  return (prefs as { whatsapp?: unknown } | null)?.whatsapp === false;
}

function segmentOf(input: Partial<CampaignInput>): Prisma.InputJsonValue {
  return input.inactiveDays ? { inactiveDays: input.inactiveDays } : {};
}

function inactiveFilter(inactiveDays?: number | null, now = new Date()): Prisma.ClientWhereInput {
  if (!inactiveDays) return {};
  const since = new Date(now.getTime() - inactiveDays * 24 * 60 * 60 * 1000);
  return { OR: [{ lastVisit: { lt: since } }, { lastVisit: null }] };
}
