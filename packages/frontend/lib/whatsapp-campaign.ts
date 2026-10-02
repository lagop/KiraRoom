import type { WhatsAppCampaign } from "./api";

/**
 * What the WhatsApp campaigns page shows. Kept apart from the page so the
 * wording of each state is tested: a campaign waiting for Meta must never
 * read as "sent", and a rejected one must say why.
 */

/** Same limit and footer as the server (whatsapp/campaigns/campaign-template.ts). */
export const MAX_BODY_LENGTH = 1024;
export const CAMPAIGN_FOOTER = "Responde BAJA si no quieres más promociones";

export type Tone = "gray" | "amber" | "blue" | "green" | "red";

export interface CampaignLabel {
  text: string;
  tone: Tone;
  /** A second line: Meta's reason, the schedule, what went wrong. */
  detail?: string;
}

export function campaignLabel(c: WhatsAppCampaign, formatDate: (iso: string) => string): CampaignLabel {
  switch (c.status) {
    case "draft":
      return c.templateStatus === "REJECTED"
        ? {
            text: "Rechazada por Meta",
            tone: "red",
            detail: `Motivo: ${rejectionReason(c.templateReason)}. Cambia el texto y vuelve a enviarla a revisión.`,
          }
        : { text: "Borrador", tone: "gray" };
    case "scheduled":
      if (c.templateStatus !== "APPROVED") {
        return {
          text: "En revisión de Meta",
          tone: "amber",
          detail: "Meta suele revisarla en unas horas. Se enviará en cuanto la apruebe" +
            (c.scheduledAt ? ` y llegue la hora programada (${formatDate(c.scheduledAt)}).` : "."),
        };
      }
      return c.scheduledAt && new Date(c.scheduledAt).getTime() > Date.now()
        ? { text: "Programada", tone: "blue", detail: `Se enviará el ${formatDate(c.scheduledAt)}.` }
        : { text: "Aprobada", tone: "blue", detail: "Empieza a enviarse en un minuto." };
    case "sending":
      return { text: "Enviando", tone: "blue", detail: `A ${c.totalRecipients} clientes.` };
    case "completed":
      return c.lastError
        ? { text: "Sin destinatarios", tone: "gray", detail: c.lastError }
        : { text: "Enviada", tone: "green", detail: c.completedAt ? formatDate(c.completedAt) : undefined };
    case "failed":
      return { text: "No enviada", tone: "red", detail: c.lastError ?? undefined };
    case "cancelled":
      return { text: "Cancelada", tone: "gray" };
    default:
      return { text: c.status, tone: "gray" };
  }
}

/** Meta's rejection codes, in words a salon understands. */
export function rejectionReason(code: string | null | undefined): string {
  switch ((code ?? "").toUpperCase()) {
    case "PROMOTIONAL":
    case "INCORRECT_CATEGORY":
      return "Meta no la ha aceptado en esa categoría";
    case "ABUSIVE_CONTENT":
      return "Meta considera el contenido inapropiado";
    case "INVALID_FORMAT":
      return "el formato del texto no es válido";
    case "SCAM":
      return "Meta lo ha considerado engañoso";
    case "":
    case "NONE":
      return "Meta no ha indicado el motivo";
    default:
      return code as string;
  }
}

/** The message as a client would read it, with an example name. */
export function previewBody(body: string, exampleName = "Ana"): string {
  return body.replace(/\{\{\s*nombre\s*\}\}/gi, exampleName);
}

/** The server's checks, to warn while typing (the server has the last word). */
export function bodyProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const names = text.match(/\{\{\s*nombre\s*\}\}/gi) ?? [];
  if (names.length > 1) return "Usa {{nombre}} una sola vez.";
  if (/\{\{(?!\s*nombre\s*\}\})/i.test(text)) return "El único marcador permitido es {{nombre}}.";
  if (/^\{\{\s*nombre\s*\}\}/i.test(text) || /\{\{\s*nombre\s*\}\}$/i.test(text)) {
    return "El mensaje no puede empezar ni terminar con {{nombre}}.";
  }
  if (text.length > MAX_BODY_LENGTH) return `Máximo ${MAX_BODY_LENGTH} caracteres (llevas ${text.length}).`;
  if (/\n{3,}/.test(text)) return "Deja como mucho una línea en blanco seguida.";
  return null;
}

/** Which actions a campaign allows in its current state. */
export function campaignActions(c: WhatsAppCampaign) {
  return {
    edit: c.status === "draft",
    submit: c.status === "draft",
    cancel: c.status === "scheduled" || c.status === "sending",
    remove: c.status !== "sending",
  };
}
