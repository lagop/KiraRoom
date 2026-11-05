import { escapeHtml } from "../common/html-escape";

export interface GiftCardEmailData {
  salonName: string;
  salonAddress?: string | null;
  salonPhone?: string | null;
  recipientName?: string | null;
  amountCents: number;
  code: string;
  /** The salon calendar day the card is valid until ("YYYY-MM-DD"), or null. */
  expiresOn: string | null;
  message?: string | null;
}

/** "50,00 €" */
export function formatEuros(cents: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(cents / 100);
}

/** "31 de diciembre de 2026" from a calendar day. */
export function formatDayEs(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The 12-character code in groups of four, easier to read out at the till. */
export function displayCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * The email the recipient of a gift card gets: who it is from, how much,
 * the code, until when, and how to use it. Same look as the other client
 * emails (review request).
 */
export function buildGiftCardEmail(data: GiftCardEmailData): { subject: string; html: string; text: string } {
  const amount = formatEuros(data.amountCents);
  const code = displayCode(data.code);
  const until = data.expiresOn ? formatDayEs(data.expiresOn) : null;
  const greetingText = data.recipientName ? `Hola ${data.recipientName},` : "Hola,";
  const subject = `Tienes una tarjeta regalo de ${amount} en ${data.salonName}`;
  const salon = escapeHtml(data.salonName);
  const contact = [data.salonAddress, data.salonPhone].filter(Boolean).join(" · ");

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
          <p style="font-size:16px;line-height:1.6;margin:0 0 16px 0;">${escapeHtml(greetingText)}</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px 0;">
            Te han regalado una tarjeta regalo de <strong>${escapeHtml(amount)}</strong> para usar en ${salon}.
          </p>
          ${
            data.message
              ? `<blockquote style="margin:0 0 24px 0;padding:12px 16px;border-left:4px solid #7c3aed;background:#f5f3ff;font-size:15px;line-height:1.6;white-space:pre-line;">${escapeHtml(data.message)}</blockquote>`
              : ""
          }
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:16px 20px;">
              <div style="font-size:13px;color:#64748b;margin-bottom:4px;">Código de la tarjeta</div>
              <div style="font-size:24px;font-weight:700;letter-spacing:2px;font-family:Menlo,Consolas,monospace;">${escapeHtml(code)}</div>
              <div style="font-size:14px;color:#334155;margin-top:12px;">Saldo: <strong>${escapeHtml(amount)}</strong></div>
              <div style="font-size:14px;color:#334155;margin-top:4px;">${
                until ? `Válida hasta el ${escapeHtml(until)} (incluido)` : "Sin fecha de caducidad"
              }</div>
            </td></tr>
          </table>
          <p style="font-size:15px;font-weight:600;margin:0 0 8px 0;">Cómo usarla</p>
          <ul style="font-size:14px;line-height:1.6;margin:0 0 24px 0;padding-left:20px;color:#334155;">
            <li>Pide cita en ${salon} como siempre.</li>
            <li>Al pagar, di que tienes una tarjeta regalo y enseña este código.</li>
            <li>Se descuenta lo que gastes; si sobra saldo, puedes usarlo en otra visita.</li>
          </ul>
          ${contact ? `<p style="font-size:13px;color:#64748b;line-height:1.6;margin:0 0 8px 0;">${escapeHtml(contact)}</p>` : ""}
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
          <p style="font-size:12px;color:#94a3b8;line-height:1.5;margin:0;">
            Te escribimos de parte de ${salon} porque alguien te ha regalado esta tarjeta. Guarda este email: el código es lo que vale.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

  const text = [
    greetingText,
    ``,
    `Te han regalado una tarjeta regalo de ${amount} para usar en ${data.salonName}.`,
    ...(data.message ? [``, data.message] : []),
    ``,
    `Código: ${code}`,
    `Saldo: ${amount}`,
    until ? `Válida hasta el ${until} (incluido)` : `Sin fecha de caducidad`,
    ``,
    `Cómo usarla: pide cita como siempre y, al pagar, di que tienes una tarjeta regalo y enseña este código. Se descuenta lo que gastes; si sobra saldo, puedes usarlo en otra visita.`,
    ...(contact ? [``, contact] : []),
    ``,
    `Guarda este email: el código es lo que vale.`,
  ].join("\n");

  return { subject, html, text };
}
