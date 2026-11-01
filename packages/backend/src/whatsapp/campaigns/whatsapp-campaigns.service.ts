import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma, WhatsAppCampaignStatus, WhatsAppRecipientStatus } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { FeatureFlagService } from "../../common/feature-flags/feature-flag.service";
import { clientsWhoAcceptedWhatsAppMarketing } from "../../consent/marketing-consent";
import { WhatsAppTemplateService } from "../whatsapp-template.service";
import { templateParam } from "../whatsapp-templates";
import {
  attemptOf,
  campaignTemplatePayload,
  compileBody,
  templateNameFor,
  withinCampaignWindow,
} from "./campaign-template";
import { DISCONNECTED_REASON, TOKEN_EXPIRED_REASON, accountLevelReason } from "./meta-account-errors";

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
/** The plan feature WhatsApp campaigns need (Pro and Empresa). */
export const CAMPAIGN_FEATURE = "whatsapp_marketing" as const;
/** Why a campaign of a salon whose plan lost campaigns stopped. */
export const PLAN_REASON = "Tu plan no incluye campañas de WhatsApp";

/**
 * WhatsApp promotions from the salon's own number.
 *
 * Draft -> "Enviar a revisión": the text goes to Meta as a MARKETING
 * template on the salon's WhatsApp Business account and the campaign is
 * scheduled. The dispatcher then, every minute: reads Meta's verdict
 * (rejected -> back to draft with Meta's reason), starts approved campaigns
 * whose time has come, and sends in batches.
 *
 * Messages only go out from 9:00 to 21:00 in the salon's time zone, and
 * never on Sunday there; a campaign approved at night waits for the
 * morning, one due on a Sunday for Monday at 9:00.
 *
 * Campaigns are a Pro feature (whatsapp_marketing). A salon whose plan does
 * not include them (Esencial, or after moving down from Pro) keeps reading
 * its past campaigns, but nothing new starts or goes on: a campaign due or
 * sending is paused with PLAN_REASON, and "Reanudar" needs the plan again.
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
    private readonly featureFlags: FeatureFlagService,
  ) {}

  // ─── Panel ────────────────────────────────────────────────────────────

  /**
   * The salon's campaigns with their counts worked out now from the
   * recipients: Meta's delivered/read statuses keep arriving for days after
   * the last message went out, so counts stored when sending finished went
   * stale at once.
   */
  async list(tenantId: string) {
    const campaigns = await this.prisma.whatsAppCampaign.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    if (campaigns.length === 0) return campaigns;
    const groups = await this.prisma.whatsAppCampaignRecipient.groupBy({
      by: ["campaignId", "status"],
      where: { campaignId: { in: campaigns.map((c) => c.id) } },
      _count: { _all: true },
    });
    const byCampaign = new Map<string, Record<string, number>>();
    for (const g of groups) {
      const row = byCampaign.get(g.campaignId) ?? {};
      row[g.status] = g._count._all;
      byCampaign.set(g.campaignId, row);
    }
    return campaigns.map((c) => ({ ...c, ...countsFrom(byCampaign.get(c.id) ?? {}) }));
  }

  /**
   * Whether the salon's plan includes campaigns, for the page: without it
   * the page shows the past campaigns and an upgrade notice.
   */
  async access(tenantId: string): Promise<{ included: boolean }> {
    return { included: await this.featureFlags.isFeatureUnlocked(tenantId, CAMPAIGN_FEATURE) };
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
    return { ...campaign, ...countsFrom(byStatus), byStatus };
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
    // Its template would otherwise stay on the salon's WhatsApp Business
    // account for good (one per campaign, and per resubmission).
    await this.dropMetaTemplate(tenantId, campaign.templateId, "campaign deleted");
    return { deleted: true };
  }

  /** Stops a scheduled, sending or paused campaign; what was sent stays sent. */
  async cancel(tenantId: string, id: string) {
    const campaign = await this.find(tenantId, id);
    const cancellable: WhatsAppCampaignStatus[] = [
      WhatsAppCampaignStatus.scheduled,
      WhatsAppCampaignStatus.sending,
      WhatsAppCampaignStatus.paused,
    ];
    if (!cancellable.includes(campaign.status)) {
      throw new ConflictException("Esta campaña no está programada ni enviándose.");
    }
    return this.prisma.whatsAppCampaign.update({
      where: { id },
      data: { status: WhatsAppCampaignStatus.cancelled, completedAt: new Date() },
    });
  }

  /**
   * "Reanudar": a campaign paused by an account-level Meta error goes on
   * sending to the clients not yet reached. Checks first what can be checked
   * (connection, token expiry, the template's status at Meta); a payment
   * problem cannot be, so if it is still there the next message pauses the
   * campaign again, and that client stays pending.
   */
  async resume(tenantId: string, id: string) {
    const campaign = await this.find(tenantId, id);
    if (campaign.status !== WhatsAppCampaignStatus.paused) {
      throw new ConflictException("Esta campaña no está en pausa.");
    }
    if (!(await this.planIncludesCampaigns(campaign.tenantId))) {
      throw new ConflictException(`${PLAN_REASON}: cambia a Pro en Facturación para reanudarla.`);
    }
    const account = await this.accountProblem(tenantId, new Date());
    if (account === "disconnected") {
      throw new ConflictException("El WhatsApp del salón no está conectado: conéctalo en Ajustes → WhatsApp antes de reanudar.");
    }
    if (account === "expired") {
      throw new ConflictException(
        "El acceso a tu cuenta de WhatsApp Business ha caducado: vuelve a conectar el WhatsApp en Ajustes → WhatsApp antes de reanudar.",
      );
    }
    let review: { status: string; reason?: string } | null;
    try {
      review = await this.templates.templateReview(tenantId, campaign.templateId);
    } catch (err) {
      throw new ConflictException(
        `No se ha podido comprobar la campaña con Meta (${(err as Error).message}). Si el acceso ha caducado, vuelve a conectar el WhatsApp en Ajustes → WhatsApp.`,
      );
    }
    if (!review) {
      throw new ConflictException("La plantilla de esta campaña ya no está en tu cuenta de WhatsApp Business: crea la campaña de nuevo.");
    }
    if (review.status !== "APPROVED") {
      await this.prisma.whatsAppCampaign.update({ where: { id }, data: { templateStatus: review.status } });
      throw new ConflictException(
        review.status === "PAUSED"
          ? "Meta mantiene en pausa la plantilla de esta campaña. Vuelve a intentarlo más tarde."
          : review.status === "DISABLED"
            ? "Meta ha desactivado la plantilla de esta campaña: no se puede reanudar. Crea una campaña nueva con otro texto."
            : `Meta tiene la plantilla en estado ${review.status}: todavía no se puede reanudar.`,
      );
    }
    // Paused before it started (its plan lost campaigns while it waited):
    // back to the queue, where the dispatcher works out the audience.
    const resumed = await this.prisma.whatsAppCampaign.updateMany({
      where: { id, tenantId, status: WhatsAppCampaignStatus.paused },
      data: {
        status: campaign.startedAt ? WhatsAppCampaignStatus.sending : WhatsAppCampaignStatus.scheduled,
        lastError: null,
        templateStatus: "APPROVED",
      },
    });
    if (resumed.count === 0) throw new ConflictException("Esta campaña no está en pausa.");
    return this.get(tenantId, id);
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
    const updated = await this.prisma.whatsAppCampaign.update({
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
    // The rejected template this one replaces is of no further use.
    if (campaign.templateId && campaign.templateId !== name) {
      await this.dropMetaTemplate(tenantId, campaign.templateId, "replaced by a new submission");
    }
    return updated;
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
    const plans = new Map<string, boolean>();
    for (const campaign of due) {
      if (!(await this.planIncludesCampaigns(campaign.tenantId, plans))) {
        await this.pause(campaign.id, PLAN_REASON, "plan", WhatsAppCampaignStatus.scheduled);
        continue;
      }
      if (!withinCampaignWindow(now, campaign.tenant?.timezone ?? "Europe/Madrid")) continue;
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
    const plans = new Map<string, boolean>();
    for (const campaign of sending) {
      // The plan no longer includes campaigns: the rest waits, paused.
      if (!(await this.planIncludesCampaigns(campaign.tenantId, plans))) {
        await this.pause(campaign.id, PLAN_REASON, "plan");
        continue;
      }
      // A batch interrupted at 21:00 carries on the next morning; one left
      // on Saturday evening, on Monday at 9:00.
      if (!withinCampaignWindow(now, campaign.tenant?.timezone ?? "Europe/Madrid")) continue;
      const pending = await this.prisma.whatsAppCampaignRecipient.findMany({
        where: { campaignId: campaign.id, status: WhatsAppRecipientStatus.pending },
        take: BATCH,
        orderBy: { createdAt: "asc" },
      });
      if (pending.length === 0) {
        await this.finish(campaign.id);
        continue;
      }

      // Known before sending anything: a disconnected number or an expired
      // token would only fail every message of the batch.
      const account = await this.accountProblem(campaign.tenantId, now);
      if (account) {
        await this.pause(campaign.id, account === "expired" ? TOKEN_EXPIRED_REASON : DISCONNECTED_REASON);
        continue;
      }

      // Consent is checked again per batch: a client may have answered BAJA
      // to another campaign or withdrawn at the salon since the start.
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
        // Cancelled (or paused) from the panel while this batch runs: stop
        // here, not 50 messages later.
        if (!(await this.stillSending(campaign.id))) {
          this.logger.log(`WhatsApp campaign ${campaign.id}: no longer sending, batch stopped`);
          break;
        }
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
        // About the salon's account or the template, not this client: every
        // other message would fail the same way. Paused, and this client and
        // the rest stay pending for "Reanudar".
        const accountReason = accountLevelReason(result.reason);
        if (accountReason) {
          await this.pause(campaign.id, accountReason, result.reason);
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

  /** Nobody left pending. The counts are worked out when read (list/get), not here. */
  private async finish(campaignId: string) {
    await this.prisma.whatsAppCampaign.updateMany({
      where: { id: campaignId, status: WhatsAppCampaignStatus.sending },
      data: { status: WhatsAppCampaignStatus.completed, completedAt: new Date() },
    });
  }

  /**
   * Stops a sending campaign for an account-level problem (or a scheduled
   * one whose plan lost campaigns); the pending recipients stay pending.
   */
  private async pause(
    campaignId: string,
    reason: string,
    code?: string,
    from: WhatsAppCampaignStatus = WhatsAppCampaignStatus.sending,
  ) {
    const paused = await this.prisma.whatsAppCampaign.updateMany({
      where: { id: campaignId, status: from },
      data: { status: WhatsAppCampaignStatus.paused, lastError: reason },
    });
    if (paused.count > 0) {
      this.logger.warn(`WhatsApp campaign ${campaignId}: paused (${code ?? "account check"})`);
    }
  }

  /**
   * Does the salon's plan (or trial) include WhatsApp campaigns? Read once
   * per salon per dispatcher run when a cache is given. An error reads as
   * "yes": a database hiccup must not pause every campaign.
   */
  private async planIncludesCampaigns(tenantId: string, cache?: Map<string, boolean>): Promise<boolean> {
    const known = cache?.get(tenantId);
    if (known !== undefined) return known;
    let included: boolean;
    try {
      included = await this.featureFlags.isFeatureUnlocked(tenantId, CAMPAIGN_FEATURE);
    } catch (err) {
      this.logger.warn(`Plan check for tenant ${tenantId} failed: ${(err as Error).message}`);
      included = true;
    }
    cache?.set(tenantId, included);
    return included;
  }

  /** Whether the campaign is still sending, read now (it may have been cancelled mid-batch). */
  private async stillSending(campaignId: string): Promise<boolean> {
    const row = await this.prisma.whatsAppCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    return row?.status === WhatsAppCampaignStatus.sending;
  }

  /** What is wrong with the salon's WhatsApp connection that is known without asking Meta. */
  private async accountProblem(tenantId: string, now: Date): Promise<"disconnected" | "expired" | null> {
    const conn = await this.prisma.whatsAppConnection.findUnique({
      where: { tenantId },
      select: { isActive: true, phoneNumberId: true, tokenExpiresAt: true },
    });
    if (!conn?.isActive || !conn.phoneNumberId) return "disconnected";
    if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() <= now.getTime()) return "expired";
    return null;
  }

  /** Deletes a campaign's template from Meta; a failure is logged, never thrown. */
  private async dropMetaTemplate(tenantId: string, name: string | null | undefined, why: string) {
    if (!name) return;
    const result = await this.templates
      .deleteTemplate(tenantId, name)
      .catch((err: Error) => ({ deleted: false, error: err.message }));
    if (!result.deleted) {
      this.logger.warn(`WhatsApp template ${name} of tenant ${tenantId} not deleted from Meta (${why}): ${result.error ?? "unknown"}`);
    }
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

/**
 * A campaign's counts from its recipients by status. A message read was also
 * delivered and sent, so each count includes the later ones.
 */
export function countsFrom(byStatus: Record<string, number>) {
  const n = (s: WhatsAppRecipientStatus) => byStatus[s] ?? 0;
  const read = n(WhatsAppRecipientStatus.read);
  const delivered = n(WhatsAppRecipientStatus.delivered) + read;
  return {
    sent: n(WhatsAppRecipientStatus.sent) + delivered,
    delivered,
    read,
    failed: n(WhatsAppRecipientStatus.failed),
    optedOut: n(WhatsAppRecipientStatus.opted_out),
    pending: n(WhatsAppRecipientStatus.pending),
  };
}

function segmentOf(input: Partial<CampaignInput>): Prisma.InputJsonValue {
  return input.inactiveDays ? { inactiveDays: input.inactiveDays } : {};
}

/**
 * "Sin venir desde hace N días": clients whose last completed visit is older
 * than that. A client with no completed visit at all is left out (the
 * owner's rule: campaigns only to clients who came at least once).
 */
export function inactiveFilter(inactiveDays?: number | null, now = new Date()): Prisma.ClientWhereInput {
  if (!inactiveDays) return {};
  const since = new Date(now.getTime() - inactiveDays * 24 * 60 * 60 * 1000);
  return { lastVisit: { lt: since } };
}
