import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";
import { TranslationsService } from "../../translations/translations.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { PlatformEmailConfigService } from "../../platform/platform-email-config.service";
import { EmailSettings, senderDomain } from "../../platform/email-settings";
import { isPlaceholderEmail } from "../../common/placeholder-email";
import { escapeHtml } from "../../common/html-escape";

/**
 * How long a send may take before the caller gives up on it. Resend's client
 * has no timeout of its own, so a hung provider used to hold a scheduler
 * tick (and every reminder after it) indefinitely.
 */
export const EMAIL_SEND_TIMEOUT_MS = 15_000;

/** Rejects when `promise` has not settled within `ms`. The request itself is not aborted. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Email provider did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  sendAt?: Date; // For scheduling emails with Resend
  /**
   * Extra RFC 822 headers (e.g. `List-Unsubscribe`). Pass-through to
   * Resend. The service also auto-adds List-Unsubscribe for any
   * single-recipient transactional email when `listUnsubscribe: true`
   * is set (default for `sendTransactional` callers).
   */
  headers?: Record<string, string>;
  /**
   * Set to `true` to auto-add a `List-Unsubscribe: <mailto:…>` header
   * pointing at `unsubscribe@<EMAIL_FROM_DOMAIN>`. Recommended for
   * all transactional emails per RFC 8058. Defaults to `false` to
   * preserve the historical behavior of one-off `sendEmail` callers.
   */
  listUnsubscribe?: boolean;
  /**
   * Resend's Idempotency-Key: a retry with the same key within 24 hours is
   * not delivered twice (e.g. after a send that timed out but went through).
   */
  idempotencyKey?: string;
}

export interface BatchEmailOptions {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
  reply_to?: string;
  send_at?: string; // ISO 8601 format for scheduled delivery
}

export interface AppointmentEmailData {
  clientName: string;
  clientEmail: string;
  serviceName: string;
  professionalName: string;
  date: string;
  time: string;
  salonName: string;
  salonAddress?: string;
  salonPhone?: string;
  /**
   * Not used: the appointment emails are in Spanish. No caller knows the
   * salon's language today, and the dates they pass are already Spanish.
   */
  language?: string;
}

/** "23 de noviembre de 2026", in Madrid time so a late-UTC instant shows the right day. */
export function formatLongDateEs(date: Date): string {
  return date.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Madrid",
  });
}

/**
 * An appointment's date as the client reads it. A calendar day
 * ("2026-11-02", what the reminder scheduler passes, or its midnight-UTC
 * serialisation) becomes "lunes, 2 de noviembre de 2026"; it is the salon's
 * own calendar day, so it is read in UTC and never shifts. Anything else is
 * already a formatted date and is shown as given.
 */
export function displayDate(date: string): string {
  const value = String(date ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(value);
  if (!m) return value;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The appointment card's look in the confirmation and reminders. */
const CARD_DEFAULT = {
  title: "📅 Detalles de la cita",
  background: "#f9fafb",
  border: "#e5e7eb",
  titleColor: "#111827",
  accent: "#667eea",
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  /** The key `resend` was built with: a new one in the console builds a new client. */
  private resendKey: string | null = null;

  constructor(
    private configService: ConfigService,
    private translationsService: TranslationsService,
    private readonly prisma: PrismaService,
    // The platform console's settings, falling back to the server's .env.
    // Always injected in the app (a module that forgets PlatformModule fails
    // at boot); tests that build the service by hand leave it out.
    private readonly platformEmail?: PlatformEmailConfigService,
  ) {}

  /** API key, sender and webhook secret in force (console, else .env). */
  private settings(): EmailSettings {
    if (this.platformEmail) return this.platformEmail.current();
    return {
      apiKey: this.configService.get<string>("RESEND_API_KEY") || null,
      from: this.configService.get<string>("EMAIL_FROM") || null,
      webhookSecret: this.configService.get<string>("RESEND_WEBHOOK_SECRET") || null,
    };
  }

  /** The Resend client for the key in force, or null when there is none. */
  private client(): Resend | null {
    const key = this.settings().apiKey;
    if (!key) return null;
    if (!this.resend || key !== this.resendKey) {
      this.resend = new Resend(key);
      this.resendKey = key;
    }
    return this.resend;
  }

  private fromAddress(): string {
    return this.settings().from || "noreply@yourdomain.com";
  }

  /**
   * Check if email service is configured
   */
  isConfigured(): boolean {
    return !!this.settings().apiKey;
  }

  /** Whether Resend's delivery events can be verified (webhook secret set). */
  isTrackingConfigured(): boolean {
    return !!this.settings().webhookSecret;
  }

  /**
   * Send raw email
   */
  async sendEmail(
    options: EmailOptions,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const resend = this.client();
    if (!resend) {
      this.logger.warn("Email service not configured - skipping email send");
      return { success: false, error: "Email service not configured" };
    }

    const to = this.deliverableRecipients(options.to);
    if (!to.length) {
      this.logger.warn("Email to a placeholder address only - skipping email send");
      return { success: false, error: "No deliverable recipient" };
    }

    const from = this.fromAddress();

    const headers = this.buildHeaders(options, from);

    try {
      const { data, error } = await withTimeout(
        resend.emails.send(
          {
            from,
            to,
            subject: options.subject,
            html: options.html,
            text: options.text,
            replyTo: options.replyTo,
            headers,
          },
          options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        ),
        EMAIL_SEND_TIMEOUT_MS,
      );

      if (error) {
        this.logger.error(`Failed to send email: ${error.message}`);
        return { success: false, error: error.message };
      }

      this.logger.log(`Email sent successfully: ${data?.id}`);
      return { success: true, id: data?.id };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      this.logger.error(`Failed to send email: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send a scheduled email (sent at a specific time using Resend's scheduling)
   */
  async sendScheduledEmail(
    options: EmailOptions,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const resend = this.client();
    if (!resend) {
      this.logger.warn("Email service not configured - skipping email send");
      return { success: false, error: "Email service not configured" };
    }

    const to = this.deliverableRecipients(options.to);
    if (!to.length) {
      this.logger.warn("Email to a placeholder address only - skipping email send");
      return { success: false, error: "No deliverable recipient" };
    }

    const from = this.fromAddress();

    try {
      // Build email payload with optional scheduling
      const emailPayload: any = {
        from,
        to,
        subject: options.subject,
        html: options.html,
        text: options.text,
        replyTo: options.replyTo,
        headers: this.buildHeaders(options, from),
      };

      // Add scheduled time if provided (Resend accepts send_at as Unix timestamp)
      if (options.sendAt) {
        emailPayload.send_at = Math.floor(options.sendAt.getTime() / 1000);
      }

      const { data, error } = await withTimeout(
        resend.emails.send(
          emailPayload,
          options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        ),
        EMAIL_SEND_TIMEOUT_MS,
      );

      if (error) {
        this.logger.error(`Failed to send scheduled email: ${error.message}`);
        return { success: false, error: error.message };
      }

      this.logger.log(`Scheduled email sent successfully: ${data?.id}`);
      return { success: true, id: data?.id };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      this.logger.error(`Failed to send scheduled email: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send batch emails using Resend's batch API
   * Can be used for bulk sending with optional scheduling
   */
  async sendBatchEmails(
    emails: BatchEmailOptions[],
  ): Promise<{ success: boolean; ids?: string[]; error?: string }> {
    const resend = this.client();
    if (!resend) {
      this.logger.warn(
        "Email service not configured - skipping batch email send",
      );
      return { success: false, error: "Email service not configured" };
    }

    emails = emails
      .map((email) => ({ ...email, to: this.deliverableRecipients(email.to) }))
      .filter((email) => email.to.length > 0);
    if (emails.length === 0) {
      return { success: true, ids: [] };
    }

    try {
      const { data, error } = await withTimeout(resend.batch.send(emails), EMAIL_SEND_TIMEOUT_MS);

      if (error) {
        this.logger.error(`Failed to send batch emails: ${error.message}`);
        return { success: false, error: error.message };
      }

      // Resend batch returns data with a data property containing the array
      const batchData = data as unknown as { data?: Array<{ id: string }> };
      const ids = batchData?.data?.map((email) => email.id) || [];
      this.logger.log(`Batch emails sent successfully: ${ids.length} emails`);
      return { success: true, ids };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      this.logger.error(`Failed to send batch emails: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /** The recipients without KiraRoom's placeholder addresses (never deliverable). */
  private deliverableRecipients(to: string | string[]): string[] {
    return (Array.isArray(to) ? to : [to]).filter((address) => !isPlaceholderEmail(address));
  }

  /**
   * The appointment emails to the client: confirmation, 24 h / 1 h reminder,
   * cancellation and change of date.
   *
   * In Spanish, signed with the salon's own name. They used to be in English
   * (the confirmation half and half), and a SALON_NAME setting of the server
   * replaced every salon's name with one. Every value in the HTML is escaped;
   * the plain-text part and the subject are not HTML.
   */
  async sendAppointmentConfirmation(
    data: AppointmentEmailData,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const subject = `Tu cita en ${data.salonName} está confirmada`;
    return this.sendEmail({
      to: data.clientEmail,
      subject,
      html: this.generateConfirmationHtml(data),
      text: this.generateConfirmationText(data),
    });
  }

  /**
   * Send appointment reminder (24h or 1h)
   */
  async sendAppointmentReminder(
    data: AppointmentEmailData,
    hoursBefore: number,
    options: Pick<EmailOptions, "idempotencyKey"> = {},
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const subject =
      hoursBefore === 1
        ? `Recordatorio: tu cita en ${data.salonName} es dentro de 1 hora`
        : `Recordatorio: mañana tienes cita en ${data.salonName} (${data.serviceName})`;

    return this.sendEmail({
      to: data.clientEmail,
      subject,
      html: this.generateReminderHtml(data, hoursBefore),
      text: this.generateReminderText(data, hoursBefore),
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * Send appointment cancellation
   */
  async sendAppointmentCancellation(
    data: AppointmentEmailData,
    reason?: string,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const subject = `Cita cancelada en ${data.salonName}: ${data.serviceName}, ${displayDate(data.date)}`;
    return this.sendEmail({
      to: data.clientEmail,
      subject,
      html: this.generateCancellationHtml(data, reason),
      text: this.generateCancellationText(data, reason),
    });
  }

  /**
   * Send appointment rescheduling notification
   */
  async sendAppointmentRescheduled(
    data: AppointmentEmailData,
    oldDate: string,
    oldTime: string,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const subject = `Tu cita en ${data.salonName} ha cambiado: ${displayDate(data.date)} a las ${data.time}`;
    return this.sendEmail({
      to: data.clientEmail,
      subject,
      html: this.generateRescheduledHtml(data, oldDate, oldTime),
      text: this.generateRescheduledText(data, oldDate, oldTime),
    });
  }

  // ==================== Tenant onboarding (Sprint 2 / 2.1) ====================

  /**
   * Send a magic-link invite email. Used by `InvitesService` when a
   * SaaS admin mints a `TenantInvite` for a new salon owner.
   *
   * Returns the same `{ success, id?, error? }` shape as `sendEmail`
   * so the caller can fall back to displaying the magic link in the
   * admin UI when delivery fails.
   */
  async sendTenantInvite(data: {
    to: string;
    tenantName: string;
    firstName: string | null;
    inviteLink: string;
    expiresAt: Date;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const greeting = data.firstName ? `Hola ${data.firstName},` : "Hola,";
    const expiresInDays = Math.max(
      1,
      Math.ceil(
        (data.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
      ),
    );
    const subject = `Tu invitación a KiraRoom para ${data.tenantName}`;

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
          <tr>
            <td>
              <div style="font-size:24px;font-weight:700;color:#0f172a;margin-bottom:8px;">KiraRoom</div>
              <p style="font-size:14px;color:#64748b;margin:0 0 24px 0;">Invitación para gestionar tu salón</p>

              <p style="font-size:16px;line-height:1.6;margin:0 0 16px 0;">${greeting}</p>

              <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
                Has sido invitado/a a configurar <strong>${this.escapeHtml(data.tenantName)}</strong>
                en KiraRoom, la plataforma SaaS de gestión para salones de belleza en España.
              </p>

              <p style="font-size:15px;line-height:1.6;margin:0 0 24px 0;">
                Para crear tu cuenta y empezar tu prueba gratuita de 14 días,
                haz clic en el siguiente botón. Tendrás ${expiresInDays} día(s)
                para hacerlo.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
                <tr>
                  <td style="background:#4f46e5;border-radius:8px;">
                    <a href="${data.inviteLink}"
                       style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                      Aceptar invitación
                    </a>
                  </td>
                </tr>
              </table>

              <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0 0 8px 0;">
                Si el botón no funciona, copia y pega este enlace en tu navegador:
              </p>
              <p style="font-size:12px;color:#94a3b8;word-break:break-all;background:#f1f5f9;padding:12px;border-radius:6px;margin:0 0 24px 0;">
                ${data.inviteLink}
              </p>

              <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">

              <p style="font-size:12px;color:#94a3b8;line-height:1.5;margin:0;">
                Si no esperabas este correo, puedes ignorarlo de forma segura.
                Nadie podrá crear una cuenta en tu nombre sin tu confirmación.
              </p>
            </td>
          </tr>
        </table>
        <p style="font-size:11px;color:#94a3b8;margin:16px 0 0 0;">
          © ${new Date().getFullYear()} KiraRoom SaaS · España
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

    const text = [
      greeting,
      ``,
      `Has sido invitado/a a configurar ${data.tenantName} en KiraRoom.`,
      `Para crear tu cuenta y empezar tu prueba gratuita de 14 días:`,
      data.inviteLink,
      ``,
      `El enlace caduca en ${expiresInDays} día(s).`,
      ``,
      `Si no esperabas este correo, puedes ignorarlo de forma segura.`,
    ].join("\n");

    return this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
      listUnsubscribe: true,
    });
  }

  // ==================== Sprint 2 / 2.3 — transactional templates ====================
  //
  // The 4 templates below are the canonical lifecycle emails sent by
  // the SaaS core. Every one of them:
  //   - is in Spanish (the customer's language),
  //   - has a plain-text fallback for clients that strip HTML,
  //   - auto-attaches a `List-Unsubscribe` header per RFC 8058,
  //   - routes through the standard `sendEmail` so the redactor in
  //     `logger.config.ts` strips query-string PII from pino logs.
  //
  // Bounce handling: the Resend webhook (`email-campaigns/
  // resend-events.service.ts`) stamps `User.emailBouncedAt` on a permanent
  // bounce; future transactional sends check it and
  // short-circuit. See `shouldSkipBouncedUser` below.

  /**
   * T-3 / T-1 warning that the free trial is about to end.
   * Sent by `TrialExpiryScheduler` (new in 2.3) once per trial window.
   */
  async sendTrialExpiry(data: {
    to: string;
    tenantName: string;
    daysLeft: 3 | 1;
    trialEnd: Date;
    upgradeUrl: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const subject =
      data.daysLeft === 1
        ? `Mañana termina tu prueba gratuita en KiraRoom`
        : `Tu prueba gratuita en KiraRoom termina en ${data.daysLeft} días`;

    const formattedDate = data.trialEnd.toLocaleDateString("es-ES", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:24px;font-weight:700;color:#0f172a;margin-bottom:8px;">KiraRoom</div>
          <p style="font-size:14px;color:#64748b;margin:0 0 24px 0;">Tu prueba gratuita está a punto de terminar</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            Hola,
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            Tu prueba gratuita de <strong>14 días</strong> de KiraRoom para
            <strong>${this.escapeHtml(data.tenantName)}</strong> termina el
            <strong>${formattedDate}</strong>.
            ${data.daysLeft === 1
              ? "Mañana tu cuenta pasará a modo lectura."
              : `Te quedan ${data.daysLeft} días. Pasado ese plazo, tu cuenta pasará a modo lectura.`
            }
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            Para no perder el acceso a tus citas, clientes y datos fiscales,
            añade un método de pago antes de esa fecha.
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
            <tr><td style="background:#4f46e5;border-radius:8px;">
              <a href="${data.upgradeUrl}"
                 style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                Activar mi suscripción
              </a>
            </td></tr>
          </table>
          <p style="font-size:13px;color:#64748b;line-height:1.5;margin:0;">
            Si tienes cualquier duda sobre qué plan encaja con tu salón,
            responde a este correo y te ayudamos.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
      `Tu prueba gratuita de KiraRoom termina ${data.daysLeft === 1 ? "mañana" : `en ${data.daysLeft} días`}.`,
      `Fecha de fin: ${formattedDate}.`,
      ``,
      `Pasado ese plazo tu cuenta pasará a modo lectura.`,
      `Para no perder el acceso a tus citas, clientes y datos fiscales, añade un método de pago:`,
      data.upgradeUrl,
    ].join("\n");

    return this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
      listUnsubscribe: true,
    });
  }

  /**
   * Stripe `invoice.payment_failed` notification. Sent when a recurring
   * charge fails; the SaaS admin then has 7 days to update the card
   * before Workstream 2.2 flips status to `suspended`.
   */
  async sendPaymentFailed(data: {
    to: string;
    tenantName: string;
    amount: number;
    currency: string;
    retryDate?: Date;
    updatePaymentUrl: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const subject = `No hemos podido cobrar tu suscripción de KiraRoom`;
    const formattedAmount = new Intl.NumberFormat("es-ES", {
      style: "currency",
      currency: data.currency,
    }).format(data.amount);

    const formattedRetry = data.retryDate
      ? data.retryDate.toLocaleDateString("es-ES", {
          day: "2-digit",
          month: "long",
        })
      : null;

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:24px;font-weight:700;color:#dc2626;margin-bottom:8px;">⚠️ Pago fallido</div>
          <p style="font-size:14px;color:#64748b;margin:0 0 24px 0;">No pudimos cobrar tu suscripción</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            Hola,
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            El cargo de <strong>${formattedAmount}</strong> correspondiente a tu
            suscripción de KiraRoom para <strong>${this.escapeHtml(data.tenantName)}</strong>
            no se ha podido procesar (tarjeta caducada, fondos insuficientes, etc.).
          </p>
          ${formattedRetry
            ? `<p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
                 Stripe volverá a intentarlo automáticamente el
                 <strong>${formattedRetry}</strong>. Si quieres actualizar tu método
                 de pago ahora, usa el botón de abajo.
               </p>`
            : `<p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
                 Actualiza tu método de pago cuanto antes para evitar la suspensión del servicio.
               </p>`
          }
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
            <tr><td style="background:#dc2626;border-radius:8px;">
              <a href="${data.updatePaymentUrl}"
                 style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                Actualizar método de pago
              </a>
            </td></tr>
          </table>
          <p style="font-size:12px;color:#94a3b8;line-height:1.5;margin:0;">
            Si tu suscripción entra en mora durante 7 días, pasaremos la cuenta
            a modo lectura para no acumular cargos adicionales.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
      `No hemos podido cobrar tu suscripción de KiraRoom.`,
      `Importe: ${formattedAmount}.`,
      formattedRetry
        ? `Stripe volverá a intentarlo el ${formattedRetry}.`
        : "Actualiza tu método de pago cuanto antes.",
      ``,
      `Actualizar método de pago:`,
      data.updatePaymentUrl,
    ].join("\n");

    return this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
      listUnsubscribe: true,
    });
  }

  /**
   * Confirmation sent to the person who filed a bug report. The
   * original report is forwarded to the founder in
   * `BugReportService.submit`; this is just an acknowledgement with
   * the tracking id so the reporter can reference it later.
   */
  async sendBugReportAck(data: {
    to: string;
    reportId: string;
    subject: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const shortId = data.reportId.slice(0, 8);
    const subject = `Hemos recibido tu reporte (${shortId})`;
    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:24px;font-weight:700;color:#0f172a;margin-bottom:8px;">KiraRoom</div>
          <p style="font-size:14px;color:#64748b;margin:0 0 24px 0;">Recibido · te responderemos en menos de 24h</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">Hola,</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            Hemos recibido tu reporte: <em>${this.escapeHtml(data.subject)}</em>.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            El equipo técnico lo revisará durante el siguiente día laborable.
            Si necesitamos más información te responderemos a este mismo correo.
          </p>
          <p style="font-size:13px;color:#94a3b8;background:#f1f5f9;padding:12px;border-radius:6px;margin:0;">
            Identificador de seguimiento: <strong>${shortId}</strong>
            (referencia este código si vuelves a escribirnos)
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
      `Hemos recibido tu reporte: "${data.subject}".`,
      `El equipo técnico lo revisará durante el siguiente día laborable.`,
      ``,
      `Identificador de seguimiento: ${shortId}`,
    ].join("\n");

    return this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
      listUnsubscribe: true,
    });
  }

  /**
   * Final-stage payment-failed notification. Sent by
   * `GracePeriodScheduler` when the 7-day grace period expires and
   * the tenant flips from `past_due` to `suspended`. Tone is
   * sympathetic but explicit: the account is now read-only, exports
   * remain available, reactivation requires updating the payment
   * method and Stripe confirming a successful charge.
   */
  async sendAccountSuspended(data: {
    to: string;
    tenantName: string;
    gracePeriodEndsAt: Date;
    /** End of the read-only window: what the email promises to keep. */
    readOnlyUntil: Date;
    updatePaymentUrl: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const subject = `Hemos suspendido tu cuenta de KiraRoom`;
    const formattedDate = formatLongDateEs(data.gracePeriodEndsAt);
    const keptUntil = formatLongDateEs(data.readOnlyUntil);

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:24px;font-weight:700;color:#dc2626;margin-bottom:8px;">Cuenta suspendida</div>
          <p style="font-size:14px;color:#64748b;margin:0 0 24px 0;">Tu suscripción lleva más de 7 días sin poder cobrarse</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">Hola,</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            No hemos podido procesar el cargo de tu suscripción de
            KiraRoom para <strong>${this.escapeHtml(data.tenantName)}</strong>,
            y el plazo para actualizar el pago terminó el <strong>${formattedDate}</strong>.
            Tu cuenta ha pasado a modo lectura.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            <strong>¿Qué significa esto?</strong> Puedes iniciar sesión, consultar
            y exportar tus datos y los de tus clientas, pero no podrás emitir facturas
            nuevas, registrar citas, ni modificar información, y tu página no
            acepta reservas hasta que actualices tu método de pago.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px 0;">
            Tus datos se conservan hasta el <strong>${keptUntil}</strong>.
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
            <tr><td style="background:#4f46e5;border-radius:8px;">
              <a href="${data.updatePaymentUrl}"
                 style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                Reactivar mi suscripción
              </a>
            </td></tr>
          </table>
          <p style="font-size:12px;color:#94a3b8;line-height:1.5;margin:0;">
            Si estás teniendo problemas con el cargo, responde a este correo
            y te ayudamos a resolverlo antes de perder el acceso a tus datos.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
      `Hemos suspendido tu cuenta de KiraRoom.`,
      ``,
      `No pudimos procesar el cargo de tu suscripción y el plazo para`,
      `actualizar el pago terminó el ${formattedDate}. Tu cuenta ha pasado a modo lectura:`,
      `puedes consultar y exportar tus datos, pero no emitir facturas, registrar citas`,
      `ni modificar información, y tu página no acepta reservas, hasta actualizar tu método de pago.`,
      ``,
      `Tus datos se conservan hasta el ${keptUntil}.`,
      ``,
      `Reactivar:`,
      data.updatePaymentUrl,
    ].join("\n");

    return this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
      listUnsubscribe: true,
    });
  }

  /**
   * Sent the day an account becomes read-only without a failed payment:
   * the trial ended without a plan (`BillingScheduler.expireTrials`) or the
   * subscription was cancelled, from the dashboard or in Stripe. The
   * suspended case has its own email above. Says what still works, until
   * when the data is kept, and links back to Billing.
   */
  async sendAccountReadOnly(data: {
    to: string;
    tenantName: string;
    reason: "trial_ended" | "cancelled";
    readOnlyUntil: Date;
    billingUrl: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const trial = data.reason === "trial_ended";
    const subject = trial
      ? `Tu prueba de KiraRoom ha terminado: tu cuenta está en modo lectura`
      : `Hemos cancelado tu suscripción de KiraRoom`;
    const heading = trial ? "Tu prueba gratuita ha terminado" : "Suscripción cancelada";
    const lead = trial
      ? "La prueba gratuita de 14 días ha terminado sin un plan elegido, así que tu cuenta ha pasado a modo lectura."
      : "Tu suscripción está cancelada y tu cuenta ha pasado a modo lectura. No se te volverá a cobrar.";
    const cta = trial ? "Elegir un plan" : "Reactivar mi suscripción";
    const keptUntil = formatLongDateEs(data.readOnlyUntil);
    const meaning =
      "Puedes iniciar sesión, consultar y exportar tus datos y los de tus clientas, " +
      "pero no crear ni cambiar citas, clientas ni servicios, y tu página no acepta reservas.";
    const keep = trial
      ? `Tus datos se conservan hasta el ${keptUntil}. Si eliges un plan antes, sigues donde lo dejaste, sin perder nada.`
      : `Tus datos se conservan hasta el ${keptUntil}. Si reactivas la suscripción antes, sigues donde lo dejaste, sin perder nada.`;

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:24px;font-weight:700;color:#0f172a;margin-bottom:8px;">KiraRoom</div>
          <p style="font-size:14px;color:#64748b;margin:0 0 24px 0;">${heading}</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">Hola,</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            ${lead} Cuenta: <strong>${this.escapeHtml(data.tenantName)}</strong>.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            <strong>¿Qué significa esto?</strong> ${meaning}
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px 0;">
            ${keep}
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
            <tr><td style="background:#4f46e5;border-radius:8px;">
              <a href="${data.billingUrl}"
                 style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                ${cta}
              </a>
            </td></tr>
          </table>
          <p style="font-size:13px;color:#64748b;line-height:1.5;margin:0;">
            Si tienes cualquier duda sobre qué plan encaja con tu salón,
            responde a este correo y te ayudamos.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
      `${heading}.`,
      ``,
      `${lead} Cuenta: ${data.tenantName}.`,
      ``,
      meaning,
      ``,
      keep,
      ``,
      `${cta}:`,
      data.billingUrl,
    ].join("\n");

    return this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
      listUnsubscribe: true,
    });
  }

  /**
   * P2A-receptionist-v2 H-4: sent right after the tenant's first
   * successful Stripe charge for the `multichannel` add-on. Greets
   * the salon owner, points them to the channels wizard, and
   * includes quick links for the two provider-specific docs.
   *
   * Idempotency: `AddOnsService.provisionFromStripe` only invokes
   * this when `status === 'active'` AND the previous status was
   * different, so a duplicate Stripe webhook delivery won't
   * double-send.
   */
  async sendMultichannelActivated(data: {
    to: string;
    tenantName: string;
    ownerName?: string | null;
    channelsWizardUrl: string;
    metaDocsUrl: string;
    telegramDocsUrl: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const firstName = data.ownerName?.split(" ")[0] ?? "";
    const greeting = firstName ? `Hola ${firstName},` : "Hola,";
    const subject = `Multicanal ya esta activo en tu cuenta de KiraRoom`;

    const html = `
      <p>${greeting}</p>
      <p>Confirmamos la activacion del <strong>add-on Multicanal</strong>
      en <strong>${this.escapeHtml(data.tenantName)}</strong>. Ya puedes
      conectar Messenger, Instagram y Telegram a tu recepcionista virtual
      para responder a tus clientas en su canal favorito.</p>
      <p><a href="${data.channelsWizardUrl}"
            style="display:inline-block;padding:10px 18px;background:#7c3aed;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">
        Configurar canales ahora
      </a></p>
      <p style="color:#6b7280;font-size:14px;">
        Esta misma URL esta disponible en tu dashboard:
        <strong>Ajustes &rarr; Canales del recepcionista virtual</strong>.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      <p style="font-size:13px;color:#6b7280;">
        Guias paso a paso:
      </p>
      <ul style="font-size:13px;color:#6b7280;">
        <li><a href="${data.metaDocsUrl}">Conectar Facebook Messenger + Instagram</a></li>
        <li><a href="${data.telegramDocsUrl}">Conectar Telegram (BotFather)</a></li>
      </ul>
      <p style="font-size:13px;color:#9ca3af;margin-top:24px;">
        Si tienes cualquier duda, responde a este correo y te ayudamos.
      </p>
    `;

    const text = [
      greeting,
      "",
      `Confirmamos la activacion del add-on Multicanal en ${data.tenantName}.`,
      "Ya puedes conectar Messenger, Instagram y Telegram a tu recepcionista virtual.",
      "",
      `Configurar canales ahora:`,
      data.channelsWizardUrl,
      "",
      "Guias paso a paso:",
      `- Conectar Facebook Messenger + Instagram: ${data.metaDocsUrl}`,
      `- Conectar Telegram (BotFather): ${data.telegramDocsUrl}`,
      "",
      "Si tienes cualquier duda, responde a este correo y te ayudamos.",
    ].join("\n");

    return this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
      listUnsubscribe: true,
    });
  }

  /**
   * Returns true if the recipient is a User with `emailBouncedAt` set.
   * Callers should skip the send and log the skip so the operator can
   * clean up the address. Fails open (returns false) if the lookup
   * itself errors — sending is safer than silently dropping.
   */
  private async shouldSkipBouncedUser(to: string): Promise<boolean> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: to.toLowerCase() },
        select: { emailBouncedAt: true },
      });
      if (user?.emailBouncedAt) {
        this.logger.warn(
          `Skipping email to ${to}: address bounced at ${user.emailBouncedAt.toISOString()}`,
        );
        return true;
      }
    } catch (err) {
      this.logger.debug(
        `shouldSkipBouncedUser check failed for ${to}: ${(err as Error).message}`,
      );
    }
    return false;
  }

  /**
   * Build the RFC 822 headers for a transactional send. If the caller
   * requested `listUnsubscribe: true` (or supplied their own
   * `List-Unsubscribe`), the header is auto-derived from `EMAIL_FROM`.
   * The header value follows RFC 8058: a `mailto:` URI + an `https:`
   * URI pointing at the app's notification settings page.
   */
  private buildHeaders(
    options: EmailOptions,
    from: string,
  ): Record<string, string> | undefined {
    const out: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.listUnsubscribe) {
      // The address's domain, also when the sender has a name in front
      // ("KiraRoom <notificaciones@kiraroom.com>").
      const domain = senderDomain(from) ?? "kiraroom.com";
      const baseUrl =
        this.configService.get<string>("APP_BASE_URL") ||
        this.configService.get<string>("FRONTEND_URL") ||
        "https://app.kiraroom.com";
      const mailto = `mailto:unsubscribe@${domain}`;
      const http = `${baseUrl.replace(/\/+$/, "")}/dashboard/settings/notifications`;
      out["List-Unsubscribe"] = `<${mailto}>, <${http}>`;
      out["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** HTML escape for interpolating user-controlled strings into emails. */
  private escapeHtml(input: unknown): string {
    return escapeHtml(input);
  }

  // ==================== Appointment emails: HTML ====================

  /**
   * The layout the four appointment emails share. Only `rows` values,
   * `previous` and the salon's details come from data, and they are escaped
   * here; the other strings are this file's own copy.
   */
  private appointmentHtml(
    data: AppointmentEmailData,
    parts: {
      title: string;
      banner?: { color: string; text: string };
      intro: string;
      previous?: string;
      card: { title: string; background: string; border: string; titleColor: string; accent: string };
      rows: Array<[string, string | undefined]>;
      closing: string;
      closingColor?: string;
    },
  ): string {
    const e = (v: unknown) => this.escapeHtml(v);
    const rows = parts.rows
      .filter(([, value]) => value !== undefined && value !== "")
      .map(
        ([label, value]) => `
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 120px;">${label}:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${e(value)}</td>
                </tr>`,
      )
      .join("");
    return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${parts.title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">${e(data.salonName)}</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">${parts.title}</p>
      </td>
    </tr>${
      parts.banner
        ? `
    <tr>
      <td style="background-color: ${parts.banner.color}; padding: 15px; text-align: center;">
        <p style="margin: 0; color: #ffffff; font-size: 16px; font-weight: 600;">⏰ ${parts.banner.text}</p>
      </td>
    </tr>`
        : ""
    }
    <tr>
      <td style="background-color: #ffffff; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 20px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola <strong>${e(data.clientName)}</strong>,
        </p>
        <p style="margin: 0 0 30px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          ${parts.intro}
        </p>${
          parts.previous
            ? `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f3f4f6; border-radius: 8px; border: 1px solid #e5e7eb; margin-bottom: 20px;">
          <tr>
            <td style="padding: 20px;">
              <p style="margin: 0; color: #9ca3af; font-size: 14px; text-decoration: line-through;">
                <strong>Antes:</strong> ${e(parts.previous)}
              </p>
            </td>
          </tr>
        </table>`
            : ""
        }
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: ${parts.card.background}; border-radius: 8px; border: 1px solid ${parts.card.border};">
          <tr>
            <td style="padding: 25px;">
              <h2 style="margin: 0 0 20px 0; color: ${parts.card.titleColor}; font-size: 18px; border-bottom: 2px solid ${parts.card.accent}; padding-bottom: 10px;">
                ${parts.card.title}
              </h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}
              </table>
            </td>
          </tr>
        </table>
        <p style="margin: 30px 0 0 0; color: ${parts.closingColor ?? "#374151"}; font-size: 14px; line-height: 1.6;">
          ${parts.closing}
        </p>
      </td>
    </tr>
    <tr>
      <td style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 10px 0; color: #111827; font-size: 16px; font-weight: 600;">${e(data.salonName)}</p>
              ${data.salonAddress ? `<p style="margin: 0 0 5px 0; color: #6b7280; font-size: 14px;">📍 ${e(data.salonAddress)}</p>` : ""}
              ${data.salonPhone ? `<p style="margin: 0; color: #6b7280; font-size: 14px;">📞 ${e(data.salonPhone)}</p>` : ""}
            </td>
          </tr>
        </table>
        <p style="margin: 20px 0 0 0; text-align: center; color: #9ca3af; font-size: 12px;">
          Este email se ha enviado a ${e(data.clientEmail)}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  private appointmentRows(data: AppointmentEmailData): Array<[string, string | undefined]> {
    return [
      ["Servicio", data.serviceName],
      ["Profesional", data.professionalName],
      ["Fecha", displayDate(data.date)],
      ["Hora", data.time],
    ];
  }

  private generateConfirmationHtml(data: AppointmentEmailData): string {
    return this.appointmentHtml(data, {
      title: "Cita confirmada",
      intro: "Tu cita está confirmada. ¡Te esperamos!",
      card: CARD_DEFAULT,
      rows: this.appointmentRows(data),
      closing:
        "Te recomendamos llegar 5-10 minutos antes. Si necesitas cambiar o cancelar la cita, avísanos cuanto antes.",
    });
  }

  private generateReminderHtml(data: AppointmentEmailData, hoursBefore: number): string {
    const soon = hoursBefore === 1;
    return this.appointmentHtml(data, {
      title: "Recordatorio de cita",
      banner: soon ? { color: "#ef4444", text: "¡Dentro de 1 hora!" } : { color: "#f59e0b", text: "Mañana" },
      intro: soon ? "Te recordamos que tu cita es dentro de 1 hora." : "Te recordamos tu cita de mañana.",
      card: CARD_DEFAULT,
      rows: this.appointmentRows(data),
      closing: soon
        ? "Si aún no has salido, es buen momento. ¡Hasta ahora!"
        : "¡Nos vemos mañana! Recuerda llegar 5-10 minutos antes.",
      closingColor: soon ? "#ef4444" : undefined,
    });
  }

  private generateCancellationHtml(data: AppointmentEmailData, reason?: string): string {
    return this.appointmentHtml(data, {
      title: "Cita cancelada",
      intro: "Tu cita ha sido cancelada. Estos eran sus datos:",
      card: { title: "❌ Cita cancelada", background: "#fef2f2", border: "#fecaca", titleColor: "#991b1b", accent: "#f87171" },
      rows: [...this.appointmentRows(data), ["Motivo", reason || undefined]],
      closing: "¿Quieres reservar otra cita? Escríbenos o llámanos, o reserva en nuestra web.",
    });
  }

  private generateRescheduledHtml(data: AppointmentEmailData, oldDate: string, oldTime: string): string {
    return this.appointmentHtml(data, {
      title: "Cita modificada",
      intro: "Hemos cambiado tu cita. Estos son los nuevos datos:",
      previous: `${displayDate(oldDate)} a las ${oldTime}`,
      card: { title: "✅ Nueva cita", background: "#f0fdf4", border: "#bbf7d0", titleColor: "#166534", accent: "#4ade80" },
      rows: this.appointmentRows(data),
      closing: "Te recomendamos llegar 5-10 minutos antes. Si necesitas cambiar algo más, contáctanos.",
    });
  }

  // ==================== Appointment emails: plain text ====================

  /** The plain-text version: the same content, not HTML, so nothing is escaped. */
  private appointmentText(
    data: AppointmentEmailData,
    parts: { title: string; intro: string; previous?: string; cardTitle: string; extraRows?: string[]; closing: string },
  ): string {
    return [
      data.salonName,
      parts.title,
      "",
      `Hola ${data.clientName},`,
      "",
      parts.intro,
      "",
      ...(parts.previous ? [`ANTES: ${parts.previous}`, ""] : []),
      parts.cardTitle.toUpperCase(),
      "-".repeat(parts.cardTitle.length),
      `Servicio: ${data.serviceName}`,
      `Profesional: ${data.professionalName}`,
      `Fecha: ${displayDate(data.date)}`,
      `Hora: ${data.time}`,
      ...(parts.extraRows ?? []),
      "",
      parts.closing,
      "",
      data.salonName,
      ...(data.salonAddress ? [`Dirección: ${data.salonAddress}`] : []),
      ...(data.salonPhone ? [`Teléfono: ${data.salonPhone}`] : []),
      "",
      `Este email se ha enviado a ${data.clientEmail}`,
    ].join("\n");
  }

  private generateConfirmationText(data: AppointmentEmailData): string {
    return this.appointmentText(data, {
      title: "Cita confirmada",
      intro: "Tu cita está confirmada. ¡Te esperamos!",
      cardTitle: "Detalles de la cita",
      closing:
        "Te recomendamos llegar 5-10 minutos antes. Si necesitas cambiar o cancelar la cita, avísanos cuanto antes.",
    });
  }

  private generateReminderText(data: AppointmentEmailData, hoursBefore: number): string {
    const soon = hoursBefore === 1;
    return this.appointmentText(data, {
      title: "Recordatorio de cita",
      intro: soon ? "Te recordamos que tu cita es dentro de 1 hora." : "Te recordamos tu cita de mañana.",
      cardTitle: "Detalles de la cita",
      closing: soon
        ? "Si aún no has salido, es buen momento. ¡Hasta ahora!"
        : "¡Nos vemos mañana! Recuerda llegar 5-10 minutos antes.",
    });
  }

  private generateCancellationText(data: AppointmentEmailData, reason?: string): string {
    return this.appointmentText(data, {
      title: "Cita cancelada",
      intro: "Tu cita ha sido cancelada. Estos eran sus datos:",
      cardTitle: "Cita cancelada",
      extraRows: reason ? [`Motivo: ${reason}`] : [],
      closing: "¿Quieres reservar otra cita? Escríbenos o llámanos, o reserva en nuestra web.",
    });
  }

  private generateRescheduledText(data: AppointmentEmailData, oldDate: string, oldTime: string): string {
    return this.appointmentText(data, {
      title: "Cita modificada",
      intro: "Hemos cambiado tu cita. Estos son los nuevos datos:",
      previous: `${displayDate(oldDate)} a las ${oldTime}`,
      cardTitle: "Nueva cita",
      closing: "Te recomendamos llegar 5-10 minutos antes. Si necesitas cambiar algo más, contáctanos.",
    });
  }

  /**
   * The post-visit review request (google_reviews_auto add-on).
   *
   * This used to be in English with a "Leave a Review" button pointing at
   * "#": the client got an email with nowhere to go. It now links to the
   * salon's review page and carries a one-click way to stop these emails,
   * because a review request is not something the client asked for.
   */
  async sendReviewRequest(data: {
    to: string;
    clientName: string;
    serviceName: string;
    salonName: string;
    reviewUrl: string;
    optOutUrl: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }
    const salon = this.escapeHtml(data.salonName);
    const greeting = data.clientName
      ? `Hola ${this.escapeHtml(data.clientName)},`
      : "Hola,";
    const subject = `¿Qué tal tu visita a ${data.salonName}?`;

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:22px;font-weight:700;margin-bottom:16px;">${salon}</div>
          <p style="font-size:16px;line-height:1.6;margin:0 0 16px 0;">${greeting}</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px 0;">
            Gracias por tu visita (${this.escapeHtml(data.serviceName)}). ¿Nos cuentas qué tal fue?
            Te llevará un minuto y nos ayuda mucho a mejorar.
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
            <tr><td style="background:#7c3aed;border-radius:8px;">
              <a href="${this.escapeHtml(data.reviewUrl)}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Valorar mi visita</a>
            </td></tr>
          </table>
          <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0 0 8px 0;">El enlace caduca en 14 días.</p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
          <p style="font-size:12px;color:#94a3b8;line-height:1.5;margin:0;">
            Te escribimos de parte de ${salon} porque acabas de visitarle.
            <a href="${this.escapeHtml(data.optOutUrl)}" style="color:#94a3b8;">No quiero recibir más peticiones de opinión</a>.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
      data.clientName ? `Hola ${data.clientName},` : "Hola,",
      ``,
      `Gracias por tu visita a ${data.salonName} (${data.serviceName}). ¿Nos cuentas qué tal fue? Te llevará un minuto:`,
      data.reviewUrl,
      ``,
      `El enlace caduca en 14 días.`,
      ``,
      `Si no quieres recibir más peticiones de opinión: ${data.optOutUrl}`,
    ].join("\n");

    // No List-Unsubscribe header: the generic one points at the staff
    // dashboard, which a client cannot use. The opt-out link in the body
    // is the client's way out.
    return this.sendEmail({ to: data.to, subject, html, text });
  }
  // ==================== Activation lifecycle (A3 / A4) ====================
  //
  // `AuthService.register` used to send nothing at all: the first email a new
  // salon ever received was the trial-expiry warning on day 11. A signup that
  // did not come back the next day got no nudge whatsoever.

  /**
   * Sent immediately after signup. Names the three things that have to happen
   * for the salon to get value, in the order the checklist now puts them,
   * because a welcome email that says only "welcome" is wasted.
   */
  async sendWelcome(data: {
    to: string;
    tenantName: string;
    ownerName?: string | null;
    dashboardUrl: string;
    verifyUrl?: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const greeting = data.ownerName
      ? `Hola ${this.escapeHtml(data.ownerName)},`
      : "Hola,";
    const subject = `Bienvenida a KiraRoom, ${data.tenantName}`;
    const steps = [
      "Configura tus datos, tus servicios y el horario del equipo.",
      "Comparte tu enlace de reservas o imprime tu QR.",
      "Importa tus clientas desde un CSV si ya las tienes en otro sistema.",
    ];
    const verifyBlock = data.verifyUrl
      ? `<p style="font-size:13px;color:#64748b;line-height:1.6;margin:0 0 24px 0;">Confirma tu correo para que no perdamos el contacto contigo: <a href="${data.verifyUrl}" style="color:#4f46e5;">verificar mi email</a>.</p>`
      : "";

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:24px;font-weight:700;margin-bottom:8px;">KiraRoom</div>
          <p style="font-size:14px;color:#64748b;margin:0 0 24px 0;">Tu prueba de 14 dias ya esta activa</p>
          <p style="font-size:16px;line-height:1.6;margin:0 0 16px 0;">${greeting}</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            <strong>${this.escapeHtml(data.tenantName)}</strong> ya esta creado. Tienes 14 dias
            con todo el plan Pro incluido, sin tarjeta.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 8px 0;">Tres pasos y empiezas a recibir reservas:</p>
          <ol style="font-size:15px;line-height:1.7;margin:0 0 24px 0;padding-left:20px;">
            ${steps.map((s) => `<li>${s}</li>`).join("")}
          </ol>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
            <tr><td style="background:#4f46e5;border-radius:8px;">
              <a href="${data.dashboardUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Entrar en mi salon</a>
            </td></tr>
          </table>
          ${verifyBlock}
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
          <p style="font-size:12px;color:#94a3b8;line-height:1.5;margin:0;">
            Responde a este correo si te atascas en algo. Contesta una persona.
          </p>
        </td></tr>
      </table>
      <p style="font-size:11px;color:#94a3b8;margin:16px 0 0 0;">(c) ${new Date().getFullYear()} KiraRoom SaaS - Espana</p>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
      greeting,
      ``,
      `${data.tenantName} ya esta creado en KiraRoom. Tienes 14 dias con todo el plan Pro incluido, sin tarjeta.`,
      ``,
      `Tres pasos y empiezas a recibir reservas:`,
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      ``,
      `Entra en tu salon: ${data.dashboardUrl}`,
      ...(data.verifyUrl ? [``, `Confirma tu correo: ${data.verifyUrl}`] : []),
      ``,
      `Responde a este correo si te atascas. Contesta una persona.`,
    ].join("\n");

    return this.sendEmail({ to: data.to, subject, html, text, listUnsubscribe: true });
  }

  /**
   * Standalone email-verification request, for a resend. The signup path
   * folds the link into the welcome email instead, so a new salon does not
   * get two emails at once.
   */
  async sendEmailVerification(data: {
    to: string;
    tenantName: string;
    ownerName?: string | null;
    verifyUrl: string;
    expiresAt: Date;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const greeting = data.ownerName
      ? `Hola ${this.escapeHtml(data.ownerName)},`
      : "Hola,";
    const hours = Math.max(
      1,
      Math.round((data.expiresAt.getTime() - Date.now()) / 3600000),
    );
    const subject = "Confirma tu correo en KiraRoom";

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:24px;font-weight:700;margin-bottom:24px;">KiraRoom</div>
          <p style="font-size:16px;line-height:1.6;margin:0 0 16px 0;">${greeting}</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px 0;">
            Confirma que este correo es tuyo para que los avisos de
            <strong>${this.escapeHtml(data.tenantName)}</strong> te lleguen de verdad.
            El enlace caduca en ${hours} hora(s).
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
            <tr><td style="background:#4f46e5;border-radius:8px;">
              <a href="${data.verifyUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Confirmar mi correo</a>
            </td></tr>
          </table>
          <p style="font-size:12px;color:#94a3b8;word-break:break-all;background:#f1f5f9;padding:12px;border-radius:6px;margin:0;">
            ${data.verifyUrl}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
      greeting,
      ``,
      `Confirma que este correo es tuyo para que los avisos de ${data.tenantName} te lleguen:`,
      data.verifyUrl,
      ``,
      `El enlace caduca en ${hours} hora(s).`,
    ].join("\n");

    return this.sendEmail({ to: data.to, subject, html, text, listUnsubscribe: true });
  }

  /**
   * The password-reset link. Transactional: no unsubscribe header, and sent
   * even to an address that bounced before (the person is asking for it).
   */
  async sendPasswordReset(data: {
    to: string;
    name?: string | null;
    salon?: string | null;
    resetUrl: string;
  }): Promise<{ success: boolean; id?: string; error?: string }> {
    const greeting = data.name ? `Hola ${this.escapeHtml(data.name)},` : "Hola,";
    const where = data.salon
      ? `tu cuenta de cliente en <strong>${this.escapeHtml(data.salon)}</strong>`
      : "tu cuenta de KiraRoom";
    const subject = "Restablece tu contraseña de KiraRoom";
    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:24px;font-weight:700;margin-bottom:24px;">KiraRoom</div>
          <p style="font-size:16px;line-height:1.6;margin:0 0 16px 0;">${greeting}</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px 0;">
            Alguien ha pedido restablecer la contraseña de ${where}.
            Si has sido tú, elige una nueva con este enlace. Caduca en una hora y solo sirve una vez.
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
            <tr><td style="background:#4f46e5;border-radius:8px;">
              <a href="${data.resetUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Elegir una contraseña nueva</a>
            </td></tr>
          </table>
          <p style="font-size:14px;line-height:1.6;margin:0 0 16px 0;color:#475569;">
            Si no lo has pedido tú, ignora este correo: tu contraseña no cambia.
          </p>
          <p style="font-size:12px;color:#64748b;word-break:break-all;background:#f1f5f9;padding:12px;border-radius:6px;margin:0;">
            ${data.resetUrl}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
    const text = [
      data.name ? `Hola ${data.name},` : "Hola,",
      "",
      `Alguien ha pedido restablecer la contraseña de ${data.salon ? `tu cuenta de cliente en ${data.salon}` : "tu cuenta de KiraRoom"}.`,
      "Si has sido tú, elige una nueva aquí (caduca en una hora y solo sirve una vez):",
      data.resetUrl,
      "",
      "Si no lo has pedido tú, ignora este correo: tu contraseña no cambia.",
    ].join("\n");
    return this.sendEmail({ to: data.to, subject, html, text });
  }
}
