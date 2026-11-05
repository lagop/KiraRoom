import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { EmailService } from "../../notifications/services/email.service";
import { RedisService } from "../cache/redis.service";
import { escapeHtml } from "../html-escape";
import { setOpsAlertSink } from "./ops-alert-sink";

/**
 * Emails the platform owner when something needs a human (audit 8 D15):
 *
 *   - fiscal_rejected  an invoice the AEAT (Verifactu / TicketBAI / SII)
 *                      finally rejected or that failed for good;
 *   - job_failed       a scheduled job threw (see @MonitoredJob);
 *   - email_bounces    more permanent bounces in a day than the threshold;
 *   - email_complaints more spam complaints in a day than the threshold.
 *
 * At most one email per kind (and scope, when it has one: one salon's alert
 * must not hide another's) per hour, across instances (Redis SET NX; the
 * in-memory fallback dedupes per instance). The ones held back are counted
 * and mentioned in the next email, so nothing floods the inbox and nothing
 * is silently lost.
 *
 * Recipient: OPS_ALERT_EMAIL, else FOUNDER_EMAIL, else admin@kiraroom.net.
 * Never throws: an alert that cannot be sent is logged.
 */
export type OpsAlertKind = "fiscal_rejected" | "job_failed" | "email_bounces" | "email_complaints";

export const OPS_ALERT_DEFAULT_EMAIL = "admin@kiraroom.net";
export const OPS_ALERT_WINDOW_SECONDS = 3600;
const DEFAULT_THRESHOLDS = { bounces: 20, complaints: 3 };

export function opsAlertRecipient(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPS_ALERT_EMAIL?.trim() || env.FOUNDER_EMAIL?.trim() || OPS_ALERT_DEFAULT_EMAIL;
}

function threshold(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const SUBJECTS: Record<OpsAlertKind, string> = {
  fiscal_rejected: "Factura rechazada por Hacienda",
  job_failed: "Ha fallado una tarea programada",
  email_bounces: "Muchos rebotes de correo hoy",
  email_complaints: "Quejas de spam hoy",
};

@Injectable()
export class OpsAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpsAlertService.name);

  constructor(
    private readonly email: EmailService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  onModuleInit(): void {
    setOpsAlertSink((kind, title, detail) => this.notify(kind, title, detail));
  }

  onModuleDestroy(): void {
    setOpsAlertSink(null);
  }

  /** Send one alert of this kind, unless one went out in the last hour. */
  async notify(kind: OpsAlertKind, title: string, detail: string, scope?: string): Promise<boolean> {
    try {
      const key = scope ? `ops-alert:${kind}:${scope}` : `ops-alert:${kind}`;
      const heldKey = `${key}:held`;
      const claimed = this.redis ? await this.redis.setIfAbsent(key, new Date().toISOString(), OPS_ALERT_WINDOW_SECONDS) : true;
      if (!claimed) {
        await this.redis?.increment(heldKey, OPS_ALERT_WINDOW_SECONDS * 24);
        this.logger.warn(`Ops alert ${kind} held back (one per hour): ${title}${scope ? ` [${scope}]` : ""}`);
        return false;
      }
      const heldRaw = this.redis ? await this.redis.get(heldKey) : null;
      const held = Number(heldRaw ?? 0) || 0;
      if (held > 0) await this.redis?.del(heldKey);

      const subject = `[KiraRoom] ${SUBJECTS[kind]}: ${title}`.slice(0, 200);
      const more = held > 0 ? `<p>Además, ${held} aviso(s) de este tipo en la última hora que no se enviaron para no saturar el buzón. Mira los logs o GlitchTip.</p>` : "";
      const res = await this.email.sendEmail({
        to: opsAlertRecipient(),
        subject,
        html: `<p><strong>${escapeHtml(title)}</strong></p><pre style="white-space:pre-wrap;font-family:monospace">${escapeHtml(detail).slice(0, 4000)}</pre>${more}<p style="color:#64748b;font-size:12px">Aviso automático de la plataforma (máximo uno de cada tipo por hora).</p>`,
        text: `${title}\n\n${detail.slice(0, 4000)}${held > 0 ? `\n\n+${held} aviso(s) más en la última hora.` : ""}`,
      });
      if (!res?.success) {
        this.logger.warn(`Ops alert ${kind} not sent: ${res?.error ?? "unknown error"}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Ops alert ${kind} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Count a Resend bounce or complaint event and alert when today's count
   * reaches the threshold (OPS_ALERT_BOUNCES_PER_DAY, default 20;
   * OPS_ALERT_COMPLAINTS_PER_DAY, default 3). Each Svix event id counts once.
   */
  async recordEmailEvent(type: "bounce" | "complaint", eventId: string | undefined, now: Date = new Date()): Promise<void> {
    if (!this.redis) return;
    try {
      if (eventId && !(await this.redis.setIfAbsent(`ops-alert:evt:${eventId}`, "1", 2 * 86400))) return;
      const day = now.toISOString().slice(0, 10);
      const count = await this.redis.increment(`ops-alert:count:${type}:${day}`, 2 * 86400);
      const limit =
        type === "bounce"
          ? threshold(process.env.OPS_ALERT_BOUNCES_PER_DAY, DEFAULT_THRESHOLDS.bounces)
          : threshold(process.env.OPS_ALERT_COMPLAINTS_PER_DAY, DEFAULT_THRESHOLDS.complaints);
      if (count >= limit) {
        await this.notify(
          type === "bounce" ? "email_bounces" : "email_complaints",
          `${count} ${type === "bounce" ? "rebotes permanentes" : "quejas de spam"} hoy (${day}, UTC)`,
          `El umbral es ${limit} al día. Revisa en Resend qué envíos los provocan (campañas, reportes de bugs, recordatorios) ` +
            "antes de que Resend limite la cuenta, que comparten todos los salones.",
        );
      }
    } catch (err) {
      this.logger.warn(`Could not count email ${type}: ${(err as Error).message}`);
    }
  }
}
