import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { ChannelHealthService } from "../channel-health/channel-health.service";
import { normalizePhone } from "../common/phone";
import { MetaCloudApiClient } from "./meta-cloud-api.client";
import { accountLevelReason } from "./campaigns/meta-account-errors";
import {
  APPOINTMENT_CANCELLED,
  APPOINTMENT_CONFIRMED,
  APPOINTMENT_REMINDER,
  APPOINTMENT_RESCHEDULED,
  REVIEW_REQUEST,
  STANDARD_TEMPLATES,
  TemplateDefinition,
  WAITLIST_SLOT_AVAILABLE,
  bodyParameters,
  spanishDate,
  templateCreationPayload,
} from "./whatsapp-templates";

const STATUS_TTL_MS = 30 * 60 * 1000;
const RESUBMIT_EVERY_MS = 6 * 60 * 60 * 1000;

export interface ReminderResult {
  sent: boolean;
  messageId?: string;
  /** Why it was not sent: not_connected, template_pending, meta_<code>... */
  reason?: string;
}

export type AppointmentNoticeKind = "reminder" | "confirmed" | "cancelled" | "rescheduled";

const TEMPLATE_FOR: Record<AppointmentNoticeKind, TemplateDefinition> = {
  reminder: APPOINTMENT_REMINDER,
  confirmed: APPOINTMENT_CONFIRMED,
  cancelled: APPOINTMENT_CANCELLED,
  rescheduled: APPOINTMENT_RESCHEDULED,
};

export interface AppointmentNoticeArgs {
  phone: string;
  clientName: string;
  salonName: string;
  serviceName: string;
  /** The appointment's date (for a change, the new one), stored at UTC midnight. */
  date: Date;
  time: string;
  country?: string;
}

/**
 * Submits KiraRoom's standard templates to a salon's WhatsApp Business
 * account and sends appointment reminders, confirmations, cancellations and
 * changes with them, from the salon's own number. See whatsapp-templates.ts
 * for why templates are needed.
 */
@Injectable()
export class WhatsAppTemplateService {
  private readonly logger = new Logger(WhatsAppTemplateService.name);
  private readonly statusCache = new Map<string, { at: number; statuses: Record<string, string> }>();
  private readonly lastAutoSubmit = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaCloudApiClient,
    // Optional so the unit tests that build this service by hand still can.
    @Optional() private readonly health?: ChannelHealthService,
  ) {}

  /**
   * Asks Meta to review every standard template. Ones that exist already are
   * left alone; one Meta refused comes back as "ERROR: <Meta's message>".
   */
  async submitStandardTemplates(tenantId: string): Promise<Record<string, string>> {
    const conn = await this.connection(tenantId);
    if (!conn?.wabaId) return {};
    // Meta already refused the token: every request would fail the same way.
    if (conn.authErrorAt) {
      const reason = accountLevelReason(conn.authError ?? "meta_190") ?? "meta_190";
      return Object.fromEntries(STANDARD_TEMPLATES.map((t) => [t.name, `ERROR: ${reason}`]));
    }
    const token = this.meta.decryptToken(conn.accessTokenEnc);
    const result: Record<string, string> = {};
    for (const t of STANDARD_TEMPLATES) {
      result[t.name] = await this.create(tenantId, token, conn.wabaId, t);
    }
    this.statusCache.delete(tenantId);
    return result;
  }

  /**
   * Asks Meta to review one standard template (the review request's, from
   * the Reseñas settings). "EXISTS" when it was submitted before: Meta keeps
   * its status, which standardStatus shows.
   */
  async submitTemplate(tenantId: string, template: TemplateDefinition): Promise<{ status: string } | { error: string }> {
    const conn = await this.connection(tenantId);
    if (!conn?.isActive || !conn.wabaId) return { error: "not_connected" };
    if (conn.authErrorAt) return { error: accountLevelReason(conn.authError ?? "meta_190") ?? "meta_190" };
    const status = await this.create(tenantId, this.meta.decryptToken(conn.accessTokenEnc), conn.wabaId, template);
    this.statusCache.delete(tenantId);
    return status.startsWith("ERROR: ") ? { error: status.slice("ERROR: ".length) } : { status };
  }

  private async create(tenantId: string, token: string, wabaId: string, t: TemplateDefinition): Promise<string> {
    const res = await this.meta.createTemplate(token, wabaId, templateCreationPayload(t));
    if (!res?.error) return res?.status ?? "PENDING";
    // 2388024 / "already exists": submitted before, keep its status.
    const exists = /already exists|2388024/i.test(`${res.error.code} ${res.error.message}`);
    if (!exists) {
      this.logger.warn(`Template ${t.name} for tenant ${tenantId} refused: ${res.error.message}`);
      await this.health?.whatsAppError(tenantId, res.error.code);
    }
    return exists ? "EXISTS" : `ERROR: ${res.error.message}`;
  }

  /** Meta's review status of each template on the salon's account (cached for 30 min). */
  async statuses(tenantId: string): Promise<Record<string, string>> {
    return (await this.readStatuses(tenantId)).statuses;
  }

  /**
   * The statuses, and whether Meta could be asked. An error from Meta used
   * to become an empty list, cached for 30 minutes: every template then
   * showed "Sin enviar" (and was sent for review again) when the real
   * problem was an expired token or a wrong account id. Errors are no
   * longer cached, and say so.
   */
  private async readStatuses(tenantId: string): Promise<{ statuses: Record<string, string>; known: boolean }> {
    const cached = this.statusCache.get(tenantId);
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return { statuses: cached.statuses, known: true };
    const conn = await this.connection(tenantId);
    if (!conn?.wabaId) return { statuses: {}, known: true };
    if (conn.authErrorAt) return { statuses: {}, known: false };
    let list: any;
    try {
      list = await this.meta.listTemplates(this.meta.decryptToken(conn.accessTokenEnc), conn.wabaId);
    } catch (err) {
      this.logger.warn(`Templates of tenant ${tenantId} could not be read: ${(err as Error).message}`);
      return { statuses: {}, known: false };
    }
    if (list?.error) {
      this.logger.warn(`Templates of tenant ${tenantId} could not be read: ${list.error.code} ${list.error.message}`);
      await this.health?.whatsAppError(tenantId, list.error.code);
      return { statuses: {}, known: false };
    }
    const statuses: Record<string, string> = {};
    for (const t of list?.data ?? []) statuses[`${t.name}:${t.language}`] = t.status;
    this.statusCache.set(tenantId, { at: Date.now(), statuses });
    return { statuses, known: true };
  }

  /**
   * Review status of KiraRoom's standard templates, for the settings page:
   * UNKNOWN for all when Meta could not be asked (the page then says so
   * instead of "Sin enviar").
   */
  async standardStatus(tenantId: string): Promise<Array<{ name: string; status: string }>> {
    const { statuses, known } = await this.readStatuses(tenantId);
    return STANDARD_TEMPLATES.map((t) => ({
      name: t.name,
      status: known ? (statuses[`${t.name}:${t.language}`] ?? "NOT_SUBMITTED") : "UNKNOWN",
    }));
  }

  /**
   * Sends the reminder template if the salon has WhatsApp connected and Meta
   * approved it. Otherwise says why, so the caller can use another channel.
   */
  sendAppointmentReminder(tenantId: string, args: AppointmentNoticeArgs): Promise<ReminderResult> {
    return this.sendAppointmentNotice(tenantId, "reminder", args);
  }

  /**
   * Sends the template for this kind of notice (reminder, confirmation,
   * cancellation, change) if the salon has WhatsApp connected and Meta
   * approved it. Otherwise says why, so the caller can fall back.
   */
  sendAppointmentNotice(
    tenantId: string,
    kind: AppointmentNoticeKind,
    args: AppointmentNoticeArgs,
  ): Promise<ReminderResult> {
    return this.sendTemplate(tenantId, TEMPLATE_FOR[kind], args.phone, args.country, [
      args.clientName?.trim() || "de nuevo",
      args.salonName,
      args.serviceName,
      spanishDate(args.date),
      args.time,
    ]);
  }

  /** Tells a wait-listed client that a slot opened, with the link to book it. */
  async sendWaitlistSlot(
    tenantId: string,
    args: { phone: string; clientName: string; salonName: string; serviceName: string; slotText: string; bookingUrl: string; country?: string },
  ): Promise<ReminderResult> {
    return this.sendTemplate(tenantId, WAITLIST_SLOT_AVAILABLE, args.phone, args.country, [
      args.clientName || "",
      args.salonName,
      args.serviceName,
      args.slotText,
      args.bookingUrl,
    ]);
  }

  /** Is the salon's number connected and this template approved? Without sending. */
  async canSend(tenantId: string, template: TemplateDefinition): Promise<{ ok: boolean; reason?: string }> {
    const conn = await this.connection(tenantId);
    if (!conn?.isActive || !conn.phoneNumberId) return { ok: false, reason: "not_connected" };
    if (conn.authErrorAt) return { ok: false, reason: conn.authError ?? "meta_190" };
    const status = (await this.statuses(tenantId))[`${template.name}:${template.language}`];
    if (status !== "APPROVED") return { ok: false, reason: `template_${(status ?? "missing").toLowerCase()}` };
    return { ok: true };
  }

  /** The post-visit review request, with the link to the review page. Same rules as the reminder. */
  async sendReviewRequest(
    tenantId: string,
    args: { phone: string; clientName: string; salonName: string; serviceName: string; link: string; country?: string },
  ): Promise<ReminderResult> {
    return this.sendTemplate(tenantId, REVIEW_REQUEST, args.phone, args.country, [
      args.clientName || "",
      args.salonName,
      args.serviceName,
      args.link,
    ]);
  }

  /**
   * Salons connected before a template existed only had the older ones
   * submitted: when a template is missing from their account, the standard
   * set is submitted again in the background (at most every 6 hours), and
   * this message uses the caller's fallback.
   */
  private async sendTemplate(
    tenantId: string,
    template: TemplateDefinition,
    phone: string,
    country: string | undefined,
    values: string[],
  ): Promise<ReminderResult> {
    const conn = await this.connection(tenantId);
    if (!conn?.isActive || !conn.phoneNumberId) return { sent: false, reason: "not_connected" };
    // Meta refused the token: no call until the salon reconnects (the
    // caller falls back to another channel; a campaign pauses with the reason).
    if (conn.authErrorAt) return { sent: false, reason: conn.authError ?? "meta_190" };
    const { statuses, known } = await this.readStatuses(tenantId);
    if (!known) return { sent: false, reason: "template_unknown" };
    const status = statuses[`${template.name}:${template.language}`];
    if (status !== "APPROVED") {
      if (!status) this.autoSubmit(tenantId);
      return { sent: false, reason: `template_${(status ?? "missing").toLowerCase()}` };
    }

    const to = normalizePhone(phone, country ?? "ES").replace(/\D/g, "");
    const res = await this.meta.sendTemplate(
      this.meta.decryptToken(conn.accessTokenEnc),
      conn.phoneNumberId,
      to,
      template.name,
      template.language,
      bodyParameters(values),
    );
    if (res?.error) {
      await this.health?.whatsAppError(tenantId, res.error.code);
      return { sent: false, reason: `meta_${res.error.code}` };
    }
    return { sent: true, messageId: res?.messages?.[0]?.id };
  }

  /**
   * Sends a template the caller knows is approved (a campaign's, checked by
   * name with Meta just before), skipping the cached status of the standard
   * set. Says why when it could not be sent.
   */
  async sendApprovedTemplate(
    tenantId: string,
    template: { name: string; language: string },
    phone: string,
    country: string | undefined,
    values: string[],
  ): Promise<ReminderResult> {
    const conn = await this.connection(tenantId);
    if (!conn?.isActive || !conn.phoneNumberId) return { sent: false, reason: "not_connected" };
    if (conn.authErrorAt) return { sent: false, reason: conn.authError ?? "meta_190" };
    const to = normalizePhone(phone, country ?? "ES").replace(/\D/g, "");
    const res = await this.meta.sendTemplate(
      this.meta.decryptToken(conn.accessTokenEnc),
      conn.phoneNumberId,
      to,
      template.name,
      template.language,
      values.length > 0 ? bodyParameters(values) : [],
    );
    if (res?.error) {
      await this.health?.whatsAppError(tenantId, res.error.code);
      return { sent: false, reason: `meta_${res.error.code}` };
    }
    return { sent: true, messageId: res?.messages?.[0]?.id };
  }

  /** Meta's review of one template on the salon's account, read now (not cached). */
  async templateReview(
    tenantId: string,
    name: string,
  ): Promise<{ status: string; reason?: string } | null> {
    const conn = await this.connection(tenantId);
    if (!conn?.wabaId) return null;
    const found = await this.meta.findTemplate(this.meta.decryptToken(conn.accessTokenEnc), conn.wabaId, name);
    return found ? { status: found.status, reason: found.rejected_reason } : null;
  }

  /** Asks Meta to review a template; answers Meta's status or its error message. */
  async createTemplate(
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: string } | { error: string }> {
    const conn = await this.connection(tenantId);
    if (!conn?.isActive || !conn.wabaId) return { error: "not_connected" };
    if (conn.authErrorAt) return { error: accountLevelReason(conn.authError ?? "meta_190") ?? "meta_190" };
    const res = await this.meta.createTemplate(this.meta.decryptToken(conn.accessTokenEnc), conn.wabaId, payload);
    if (res?.error) {
      await this.health?.whatsAppError(tenantId, res.error.code);
      return { error: res.error.message || `Meta ${res.error.code}` };
    }
    return { status: res?.status ?? "PENDING" };
  }

  /**
   * Deletes one of the salon's templates from Meta (a deleted or replaced
   * campaign's). Never throws: says whether it was deleted and, if not, why.
   */
  async deleteTemplate(tenantId: string, name: string): Promise<{ deleted: boolean; error?: string }> {
    try {
      const conn = await this.connection(tenantId);
      if (!conn?.wabaId) return { deleted: false, error: "not_connected" };
      const res = await this.meta.deleteTemplate(this.meta.decryptToken(conn.accessTokenEnc), conn.wabaId, name);
      if (res?.error) return { deleted: false, error: res.error.message || `Meta ${res.error.code}` };
      this.statusCache.delete(tenantId);
      return { deleted: true };
    } catch (err) {
      return { deleted: false, error: (err as Error).message };
    }
  }

  private autoSubmit(tenantId: string): void {
    const last = this.lastAutoSubmit.get(tenantId) ?? 0;
    if (Date.now() - last < RESUBMIT_EVERY_MS) return;
    this.lastAutoSubmit.set(tenantId, Date.now());
    void this.submitStandardTemplates(tenantId).catch((err) =>
      this.logger.warn(`Template submission for tenant ${tenantId} failed: ${(err as Error).message}`),
    );
  }

  private connection(tenantId: string) {
    return this.prisma.whatsAppConnection.findUnique({
      where: { tenantId },
      select: { wabaId: true, phoneNumberId: true, accessTokenEnc: true, isActive: true, authErrorAt: true, authError: true },
    });
  }
}
