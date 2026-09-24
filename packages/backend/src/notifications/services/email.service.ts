import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";
import { TranslationsService } from "../../translations/translations.service";
import { PrismaService } from "../../common/prisma/prisma.service";

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
  language?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;

  constructor(
    private configService: ConfigService,
    private translationsService: TranslationsService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>("RESEND_API_KEY");
    if (apiKey) {
      this.resend = new Resend(apiKey);
    } else {
      this.logger.warn(
        "RESEND_API_KEY not configured - email sending disabled",
      );
    }
  }

  /**
   * Check if email service is configured
   */
  isConfigured(): boolean {
    return this.resend !== null;
  }

  /**
   * Send raw email
   */
  async sendEmail(
    options: EmailOptions,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!this.resend) {
      this.logger.warn("Email service not configured - skipping email send");
      return { success: false, error: "Email service not configured" };
    }

    const from =
      this.configService.get<string>("EMAIL_FROM") || "noreply@yourdomain.com";

    const headers = this.buildHeaders(options, from);

    try {
      const { data, error } = await this.resend.emails.send({
        from,
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text,
        replyTo: options.replyTo,
        headers,
      });

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
    if (!this.resend) {
      this.logger.warn("Email service not configured - skipping email send");
      return { success: false, error: "Email service not configured" };
    }

    const from =
      this.configService.get<string>("EMAIL_FROM") || "noreply@yourdomain.com";

    try {
      // Build email payload with optional scheduling
      const emailPayload: any = {
        from,
        to: Array.isArray(options.to) ? options.to : [options.to],
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

      const { data, error } = await this.resend.emails.send(emailPayload);

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
    if (!this.resend) {
      this.logger.warn(
        "Email service not configured - skipping batch email send",
      );
      return { success: false, error: "Email service not configured" };
    }

    if (emails.length === 0) {
      return { success: true, ids: [] };
    }

    try {
      const { data, error } = await this.resend.batch.send(emails);

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

  /**
   * Send appointment confirmation
   */
  async sendAppointmentConfirmation(
    data: AppointmentEmailData,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const salonName =
      this.configService.get<string>("SALON_NAME") || data.salonName;
    const language = data.language || "es";

    const subject = this.translationsService.translate(
      language as any,
      "emails.appointment.confirmation.subject",
      {
        business_name: salonName,
      },
    );

    const html = this.generateConfirmationHtml(
      { ...data, salonName },
      language,
    );
    const text = this.generateConfirmationText(
      { ...data, salonName },
      language,
    );

    return this.sendEmail({
      to: data.clientEmail,
      subject,
      html,
      text,
    });
  }

  /**
   * Send appointment reminder (24h or 1h)
   */
  async sendAppointmentReminder(
    data: AppointmentEmailData,
    hoursBefore: number,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const salonName =
      this.configService.get<string>("SALON_NAME") || data.salonName;
    const subject = `Reminder: Your appointment ${hoursBefore === 1 ? "in 1 hour" : "tomorrow"} - ${data.serviceName}`;

    const html = this.generateReminderHtml({ ...data, salonName }, hoursBefore);
    const text = this.generateReminderText({ ...data, salonName }, hoursBefore);

    return this.sendEmail({
      to: data.clientEmail,
      subject,
      html,
      text,
    });
  }

  /**
   * Send appointment cancellation
   */
  async sendAppointmentCancellation(
    data: AppointmentEmailData,
    reason?: string,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const salonName =
      this.configService.get<string>("SALON_NAME") || data.salonName;
    const subject = `Appointment Cancelled - ${data.serviceName} on ${data.date}`;

    const html = this.generateCancellationHtml({ ...data, salonName }, reason);
    const text = this.generateCancellationText({ ...data, salonName }, reason);

    return this.sendEmail({
      to: data.clientEmail,
      subject,
      html,
      text,
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
    const salonName =
      this.configService.get<string>("SALON_NAME") || data.salonName;
    const subject = `Appointment Rescheduled - ${data.serviceName} on ${data.date}`;

    const html = this.generateRescheduledHtml(
      { ...data, salonName },
      oldDate,
      oldTime,
    );
    const text = this.generateRescheduledText(
      { ...data, salonName },
      oldDate,
      oldTime,
    );

    return this.sendEmail({
      to: data.clientEmail,
      subject,
      html,
      text,
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
  // Bounce handling: the Resend webhook at
  // `notifications/webhooks.controller.ts:handleEmailBounced` stamps
  // `User.emailBouncedAt`; future transactional sends check it and
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
    updatePaymentUrl: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    if (await this.shouldSkipBouncedUser(data.to)) {
      return { success: false, skipped: true, error: "email_bounced" };
    }

    const subject = `Hemos suspendido tu cuenta de KiraRoom`;
    const formattedDate = data.gracePeriodEndsAt.toLocaleDateString("es-ES", {
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
          <div style="font-size:24px;font-weight:700;color:#dc2626;margin-bottom:8px;">Cuenta suspendida</div>
          <p style="font-size:14px;color:#64748b;margin:0 0 24px 0;">Tu suscripción lleva más de 7 días sin poder cobrarse</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">Hola,</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            Después de los avisos enviados desde el <strong>${formattedDate}</strong>,
            no hemos podido procesar el cargo de tu suscripción de
            KiraRoom para <strong>${this.escapeHtml(data.tenantName)}</strong>.
            Tu cuenta ha pasado a modo lectura.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
            <strong>¿Qué significa esto?</strong> Puedes iniciar sesión y consultar
            tus datos y los de tus clientas, pero no podrás emitir facturas
            nuevas, registrar citas, ni modificar información hasta que
            actualices tu método de pago.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px 0;">
            Tus datos se conservan durante 60 días. Pasado ese plazo se
            anonimizarán conforme a nuestra política de privacidad.
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
      `No pudimos procesar el cargo de tu suscripción tras los avisos`,
      `enviados desde el ${formattedDate}. Tu cuenta ha pasado a modo lectura:`,
      `puedes consultar tus datos pero no emitir facturas, registrar citas`,
      `ni modificar información hasta actualizar tu método de pago.`,
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
      const domain = from.split("@")[1] ?? "kiraroom.com";
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

  /** Minimal HTML escape for interpolating user-controlled strings into emails. */
  private escapeHtml(input: string): string {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ==================== HTML Templates ====================

  private generateConfirmationHtml(
    data: AppointmentEmailData,
    language: string = "es",
  ): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Appointment Confirmation</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">${data.salonName}</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">${this.translationsService.translate(language as any, "emails.appointment.confirmation.subject")}</p>
      </td>
    </tr>
    
    <!-- Main Content -->
    <tr>
      <td style="background-color: #ffffff; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 20px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          ${this.translationsService.translate(language as any, "emails.appointment.confirmation.greeting", { client_name: data.clientName })}
        </p>
        <p style="margin: 0 0 30px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          ${this.translationsService.translate(language as any, "emails.appointment.confirmation.body")}
        </p>
        
        <!-- Appointment Details Card -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb;">
          <tr>
            <td style="padding: 25px;">
              <h2 style="margin: 0 0 20px 0; color: #111827; font-size: 18px; border-bottom: 2px solid #667eea; padding-bottom: 10px;">
                📅 Appointment Details
              </h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 120px;">Service:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.serviceName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Professional:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.professionalName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Date:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.date}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Time:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.time}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        
        <p style="margin: 30px 0 0 0; color: #374151; font-size: 14px; line-height: 1.6;">
          Please arrive 5-10 minutes before your appointment time. If you need to reschedule or cancel, please contact us as soon as possible.
        </p>
      </td>
    </tr>
    
    <!-- Footer -->
    <tr>
      <td style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 10px 0; color: #111827; font-size: 16px; font-weight: 600;">${data.salonName}</p>
              ${data.salonAddress ? `<p style="margin: 0 0 5px 0; color: #6b7280; font-size: 14px;">📍 ${data.salonAddress}</p>` : ""}
              ${data.salonPhone ? `<p style="margin: 0; color: #6b7280; font-size: 14px;">📞 ${data.salonPhone}</p>` : ""}
            </td>
          </tr>
        </table>
        <p style="margin: 20px 0 0 0; text-align: center; color: #9ca3af; font-size: 12px;">
          This email was sent to ${data.clientEmail}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  private generateReminderHtml(
    data: AppointmentEmailData,
    hoursBefore: number,
  ): string {
    const urgencyColor = hoursBefore === 1 ? "#ef4444" : "#f59e0b";
    const urgencyText = hoursBefore === 1 ? "Starting in 1 hour!" : "Tomorrow";

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Appointment Reminder</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">${data.salonName}</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">Appointment Reminder</p>
      </td>
    </tr>
    
    <!-- Urgency Banner -->
    <tr>
      <td style="background-color: ${urgencyColor}; padding: 15px; text-align: center;">
        <p style="margin: 0; color: #ffffff; font-size: 16px; font-weight: 600;">
          ⏰ ${urgencyText}
        </p>
      </td>
    </tr>
    
    <!-- Main Content -->
    <tr>
      <td style="background-color: #ffffff; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 20px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi <strong>${data.clientName}</strong>,
        </p>
        <p style="margin: 0 0 30px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          This is a friendly reminder about your upcoming appointment ${hoursBefore === 1 ? "in 1 hour" : "tomorrow"}.
        </p>
        
        <!-- Appointment Details Card -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb;">
          <tr>
            <td style="padding: 25px;">
              <h2 style="margin: 0 0 20px 0; color: #111827; font-size: 18px; border-bottom: 2px solid #667eea; padding-bottom: 10px;">
                📅 Appointment Details
              </h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 120px;">Service:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.serviceName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Professional:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.professionalName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Date:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.date}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Time:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.time}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        
        ${
          hoursBefore === 1
            ? `
        <p style="margin: 30px 0 0 0; color: #ef4444; font-size: 14px; line-height: 1.6; font-weight: 500;">
          Please head to the salon now if you haven't already. We're excited to see you soon!
        </p>
        `
            : `
        <p style="margin: 30px 0 0 0; color: #374151; font-size: 14px; line-height: 1.6;">
          We look forward to seeing you tomorrow! Please remember to arrive 5-10 minutes early.
        </p>
        `
        }
      </td>
    </tr>
    
    <!-- Footer -->
    <tr>
      <td style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 10px 0; color: #111827; font-size: 16px; font-weight: 600;">${data.salonName}</p>
              ${data.salonAddress ? `<p style="margin: 0 0 5px 0; color: #6b7280; font-size: 14px;">📍 ${data.salonAddress}</p>` : ""}
              ${data.salonPhone ? `<p style="margin: 0; color: #6b7280; font-size: 14px;">📞 ${data.salonPhone}</p>` : ""}
            </td>
          </tr>
        </table>
        <p style="margin: 20px 0 0 0; text-align: center; color: #9ca3af; font-size: 12px;">
          This email was sent to ${data.clientEmail}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  private generateCancellationHtml(
    data: AppointmentEmailData,
    reason?: string,
  ): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Appointment Cancelled</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">${data.salonName}</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">Appointment Cancelled</p>
      </td>
    </tr>
    
    <!-- Main Content -->
    <tr>
      <td style="background-color: #ffffff; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 20px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi <strong>${data.clientName}</strong>,
        </p>
        <p style="margin: 0 0 30px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          Your appointment has been cancelled. Here are the details of the cancelled appointment:
        </p>
        
        <!-- Cancelled Appointment Details Card -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fef2f2; border-radius: 8px; border: 1px solid #fecaca;">
          <tr>
            <td style="padding: 25px;">
              <h2 style="margin: 0 0 20px 0; color: #991b1b; font-size: 18px; border-bottom: 2px solid #f87171; padding-bottom: 10px;">
                ❌ Cancelled Appointment
              </h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 120px;">Service:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.serviceName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Professional:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.professionalName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Date:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.date}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Time:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.time}</td>
                </tr>
                ${
                  reason
                    ? `
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Reason:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${reason}</td>
                </tr>
                `
                    : ""
                }
              </table>
            </td>
          </tr>
        </table>
        
        <p style="margin: 30px 0 0 0; color: #374151; font-size: 14px; line-height: 1.6;">
          Would you like to book a new appointment? Please contact us or visit our website to schedule a new time.
        </p>
      </td>
    </tr>
    
    <!-- Footer -->
    <tr>
      <td style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 10px 0; color: #111827; font-size: 16px; font-weight: 600;">${data.salonName}</p>
              ${data.salonAddress ? `<p style="margin: 0 0 5px 0; color: #6b7280; font-size: 14px;">📍 ${data.salonAddress}</p>` : ""}
              ${data.salonPhone ? `<p style="margin: 0; color: #6b7280; font-size: 14px;">📞 ${data.salonPhone}</p>` : ""}
            </td>
          </tr>
        </table>
        <p style="margin: 20px 0 0 0; text-align: center; color: #9ca3af; font-size: 12px;">
          This email was sent to ${data.clientEmail}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  private generateRescheduledHtml(
    data: AppointmentEmailData,
    oldDate: string,
    oldTime: string,
  ): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Appointment Rescheduled</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">${data.salonName}</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">Appointment Rescheduled</p>
      </td>
    </tr>
    
    <!-- Main Content -->
    <tr>
      <td style="background-color: #ffffff; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 20px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi <strong>${data.clientName}</strong>,
        </p>
        <p style="margin: 0 0 30px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          Your appointment has been rescheduled. Here are the updated details:
        </p>
        
        <!-- Old Appointment (Crossed out) -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f3f4f6; border-radius: 8px; border: 1px solid #e5e7eb; margin-bottom: 20px;">
          <tr>
            <td style="padding: 20px;">
              <p style="margin: 0 0 10px 0; color: #9ca3af; font-size: 14px; text-decoration: line-through;">
                <strong>Previous:</strong> ${oldDate} at ${oldTime}
              </p>
            </td>
          </tr>
        </table>
        
        <!-- New Appointment Details Card -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f0fdf4; border-radius: 8px; border: 1px solid #bbf7d0;">
          <tr>
            <td style="padding: 25px;">
              <h2 style="margin: 0 0 20px 0; color: #166534; font-size: 18px; border-bottom: 2px solid #4ade80; padding-bottom: 10px;">
                ✅ New Appointment Details
              </h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 120px;">Service:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.serviceName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Professional:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.professionalName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Date:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.date}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Time:</td>
                  <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500;">${data.time}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        
        <p style="margin: 30px 0 0 0; color: #374151; font-size: 14px; line-height: 1.6;">
          Please arrive 5-10 minutes before your new appointment time. If you need to make further changes, please contact us.
        </p>
      </td>
    </tr>
    
    <!-- Footer -->
    <tr>
      <td style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 10px 0; color: #111827; font-size: 16px; font-weight: 600;">${data.salonName}</p>
              ${data.salonAddress ? `<p style="margin: 0 0 5px 0; color: #6b7280; font-size: 14px;">📍 ${data.salonAddress}</p>` : ""}
              ${data.salonPhone ? `<p style="margin: 0; color: #6b7280; font-size: 14px;">📞 ${data.salonPhone}</p>` : ""}
            </td>
          </tr>
        </table>
        <p style="margin: 20px 0 0 0; text-align: center; color: #9ca3af; font-size: 12px;">
          This email was sent to ${data.clientEmail}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  // ==================== Text Templates ====================

  private generateConfirmationText(
    data: AppointmentEmailData,
    language: string = "es",
  ): string {
    return `
${data.salonName}
Appointment Confirmation

Hi ${data.clientName},

Your appointment has been confirmed! We're looking forward to seeing you.

APPOINTMENT DETAILS
-------------------
Service: ${data.serviceName}
Professional: ${data.professionalName}
Date: ${data.date}
Time: ${data.time}

Please arrive 5-10 minutes before your appointment time. If you need to reschedule or cancel, please contact us as soon as possible.

${data.salonName}
${data.salonAddress ? `Address: ${data.salonAddress}` : ""}
${data.salonPhone ? `Phone: ${data.salonPhone}` : ""}

This email was sent to ${data.clientEmail}
    `.trim();
  }

  private generateReminderText(
    data: AppointmentEmailData,
    hoursBefore: number,
  ): string {
    return `
${data.salonName}
Appointment Reminder

Hi ${data.clientName},

This is a friendly reminder about your upcoming appointment ${hoursBefore === 1 ? "in 1 hour" : "tomorrow"}.

APPOINTMENT DETAILS
-------------------
Service: ${data.serviceName}
Professional: ${data.professionalName}
Date: ${data.date}
Time: ${data.time}

${
  hoursBefore === 1
    ? "Please head to the salon now if you haven't already. We're excited to see you soon!"
    : "We look forward to seeing you tomorrow! Please remember to arrive 5-10 minutes early."
}

${data.salonName}
${data.salonAddress ? `Address: ${data.salonAddress}` : ""}
${data.salonPhone ? `Phone: ${data.salonPhone}` : ""}

This email was sent to ${data.clientEmail}
    `.trim();
  }

  private generateCancellationText(
    data: AppointmentEmailData,
    reason?: string,
  ): string {
    return `
${data.salonName}
Appointment Cancelled

Hi ${data.clientName},

Your appointment has been cancelled. Here are the details of the cancelled appointment:

CANCELLED APPOINTMENT
---------------------
Service: ${data.serviceName}
Professional: ${data.professionalName}
Date: ${data.date}
Time: ${data.time}
${reason ? `Reason: ${reason}` : ""}

Would you like to book a new appointment? Please contact us or visit our website to schedule a new time.

${data.salonName}
${data.salonAddress ? `Address: ${data.salonAddress}` : ""}
${data.salonPhone ? `Phone: ${data.salonPhone}` : ""}

This email was sent to ${data.clientEmail}
    `.trim();
  }

  private generateRescheduledText(
    data: AppointmentEmailData,
    oldDate: string,
    oldTime: string,
  ): string {
    return `
${data.salonName}
Appointment Rescheduled

Hi ${data.clientName},

Your appointment has been rescheduled. Here are the updated details:

PREVIOUS APPOINTMENT (CANCELLED)
--------------------------------
Date: ${oldDate}
Time: ${oldTime}

NEW APPOINTMENT DETAILS
-----------------------
Service: ${data.serviceName}
Professional: ${data.professionalName}
Date: ${data.date}
Time: ${data.time}

Please arrive 5-10 minutes before your new appointment time. If you need to make further changes, please contact us.

${data.salonName}
${data.salonAddress ? `Address: ${data.salonAddress}` : ""}
${data.salonPhone ? `Phone: ${data.salonPhone}` : ""}

This email was sent to ${data.clientEmail}
    `.trim();
  }

  /**
   * Send review request email after appointment completion
   */
  async sendReviewRequest(data: {
    to: string;
    clientName: string;
    serviceName: string;
    professionalName: string;
    salonName: string;
    appointmentId: string;
  }): Promise<{ success: boolean; id?: string; error?: string; skipped?: boolean }> {
    const salonName =
      this.configService.get<string>("SALON_NAME") || data.salonName;
    const subject = `How was your experience? - ${data.serviceName}`;

    const html = this.generateReviewRequestHtml({ ...data, salonName });
    const text = this.generateReviewRequestText({ ...data, salonName });

    return this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
    });
  }

  private generateReviewRequestHtml(data: {
    clientName: string;
    serviceName: string;
    professionalName: string;
    salonName: string;
    appointmentId: string;
  }): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>How was your experience?</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">${data.salonName}</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">How was your experience?</p>
      </td>
    </tr>
    
    <!-- Main Content -->
    <tr>
      <td style="background-color: #ffffff; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 20px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi <strong>${data.clientName}</strong>,
        </p>
        <p style="margin: 0 0 30px 0; color: #374151; font-size: 16px; line-height: 1.6;">
          We hope you enjoyed your recent <strong>${data.serviceName}</strong> appointment with <strong>${data.professionalName}</strong>. Your feedback helps us improve and helps others find great services!
        </p>
        
        <!-- Review Button -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td style="text-align: center; padding: 20px 0;">
              <a href="#" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600;">
                Leave a Review
              </a>
            </td>
          </tr>
        </table>
        
        <p style="margin: 30px 0 0 0; color: #6b7280; font-size: 14px; line-height: 1.6; text-align: center;">
          Thank you for choosing ${data.salonName}! We look forward to seeing you again soon.
        </p>
      </td>
    </tr>
    
    <!-- Footer -->
    <tr>
      <td style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0; text-align: center; color: #9ca3af; font-size: 12px;">
          This email was sent to request your feedback on your recent appointment.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  private generateReviewRequestText(data: {
    clientName: string;
    serviceName: string;
    professionalName: string;
    salonName: string;
    appointmentId: string;
  }): string {
    return `
${data.salonName}
How was your experience?

Hi ${data.clientName},

We hope you enjoyed your recent ${data.serviceName} appointment with ${data.professionalName}. Your feedback helps us improve and helps others find great services!

Please take a moment to leave a review about your experience.

Thank you for choosing ${data.salonName}! We look forward to seeing you again soon.

This email was sent to request your feedback on your recent appointment.
    `.trim();
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
}
