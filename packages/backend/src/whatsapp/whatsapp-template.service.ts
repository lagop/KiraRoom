import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { normalizePhone } from "../common/phone";
import { MetaCloudApiClient } from "./meta-cloud-api.client";
import {
  APPOINTMENT_REMINDER,
  REVIEW_REQUEST,
  STANDARD_TEMPLATES,
  TemplateDefinition,
  WAITLIST_SLOT_AVAILABLE,
  bodyParameters,
  spanishDate,
  templateCreationPayload,
} from "./whatsapp-templates";

const STATUS_TTL_MS = 30 * 60 * 1000;

export interface ReminderResult {
  sent: boolean;
  messageId?: string;
  /** Why it was not sent: not_connected, template_pending, meta_<code>... */
  reason?: string;
}

/**
 * Submits KiraRoom's standard templates to a salon's WhatsApp Business
 * account and sends appointment reminders with them, from the salon's own
 * number. See whatsapp-templates.ts for why templates are needed.
 */
@Injectable()
export class WhatsAppTemplateService {
  private readonly logger = new Logger(WhatsAppTemplateService.name);
  private readonly statusCache = new Map<string, { at: number; statuses: Record<string, string> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaCloudApiClient,
  ) {}

  /** Asks Meta to review every standard template. Ones that exist already are left alone. */
  async submitStandardTemplates(tenantId: string): Promise<Record<string, string>> {
    const conn = await this.connection(tenantId);
    if (!conn?.wabaId) return {};
    const token = this.meta.decryptToken(conn.accessTokenEnc);
    const result: Record<string, string> = {};
    for (const t of STANDARD_TEMPLATES) {
      const res = await this.meta.createTemplate(token, conn.wabaId, templateCreationPayload(t));
      if (res?.error) {
        // 2388024 / "already exists": submitted before, keep its status.
        const exists = /already exists|2388024/i.test(`${res.error.code} ${res.error.message}`);
        result[t.name] = exists ? "EXISTS" : `ERROR: ${res.error.message}`;
        if (!exists) this.logger.warn(`Template ${t.name} for tenant ${tenantId} refused: ${res.error.message}`);
      } else {
        result[t.name] = res?.status ?? "PENDING";
      }
    }
    this.statusCache.delete(tenantId);
    return result;
  }

  /** Meta's review status of each template on the salon's account (cached for 30 min). */
  async statuses(tenantId: string): Promise<Record<string, string>> {
    const cached = this.statusCache.get(tenantId);
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.statuses;
    const conn = await this.connection(tenantId);
    if (!conn?.wabaId) return {};
    const list = await this.meta.listTemplates(this.meta.decryptToken(conn.accessTokenEnc), conn.wabaId);
    const statuses: Record<string, string> = {};
    for (const t of list?.data ?? []) statuses[`${t.name}:${t.language}`] = t.status;
    this.statusCache.set(tenantId, { at: Date.now(), statuses });
    return statuses;
  }

  /** Review status of KiraRoom's standard templates, for the settings page. */
  async standardStatus(tenantId: string): Promise<Array<{ name: string; status: string }>> {
    const statuses = await this.statuses(tenantId);
    return STANDARD_TEMPLATES.map((t) => ({
      name: t.name,
      status: statuses[`${t.name}:${t.language}`] ?? "NOT_SUBMITTED",
    }));
  }

  /**
   * Sends the reminder template if the salon has WhatsApp connected and Meta
   * approved it. Otherwise says why, so the caller can use another channel.
   */
  async sendAppointmentReminder(
    tenantId: string,
    args: { phone: string; clientName: string; salonName: string; serviceName: string; date: Date; time: string; country?: string },
  ): Promise<ReminderResult> {
    return this.sendTemplate(tenantId, APPOINTMENT_REMINDER, args.phone, args.country, [
      args.clientName || "",
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

  private async sendTemplate(
    tenantId: string,
    template: TemplateDefinition,
    phone: string,
    country: string | undefined,
    values: string[],
  ): Promise<ReminderResult> {
    const conn = await this.connection(tenantId);
    if (!conn?.isActive || !conn.phoneNumberId) return { sent: false, reason: "not_connected" };
    const key = `${template.name}:${template.language}`;
    const status = (await this.statuses(tenantId))[key];
    if (status !== "APPROVED") return { sent: false, reason: `template_${(status ?? "missing").toLowerCase()}` };

    const to = normalizePhone(phone, country ?? "ES").replace(/\D/g, "");
    const res = await this.meta.sendTemplate(
      this.meta.decryptToken(conn.accessTokenEnc),
      conn.phoneNumberId,
      to,
      template.name,
      template.language,
      bodyParameters(values),
    );
    if (res?.error) return { sent: false, reason: `meta_${res.error.code}` };
    return { sent: true, messageId: res?.messages?.[0]?.id };
  }

  private connection(tenantId: string) {
    return this.prisma.whatsAppConnection.findUnique({
      where: { tenantId },
      select: { wabaId: true, phoneNumberId: true, accessTokenEnc: true, isActive: true },
    });
  }
}
