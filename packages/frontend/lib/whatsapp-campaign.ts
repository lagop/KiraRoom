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

/**
 * When campaigns go out (the server's withinCampaignWindow): 9:00 to 21:00
 * on the salon's clock, never on Sunday. What is left on Saturday evening
 * waits for Monday at 9:00.
 */
export const SENDING_WINDOW = "Entre las 9:00 y las 21:00 (hora del salón). No se envía en domingo.";

/** Campaigns are Pro and Empresa: the page says so, with a link to Facturación. */
export const PLAN_NOTICE =
  "Las campañas de WhatsApp están incluidas en los planes Pro y Empresa. Tu plan actual no las incluye: puedes ver tus campañas anteriores, pero no crear, enviar ni reanudar ninguna.";
export const BILLING_HREF = "/dashboard/billing";

/** 403 FEATURE_NOT_IN_PLAN: the plan does not include campaigns. */
export function isPlanBlocked(error: unknown): boolean {
  // Duck-typed (ApiError carries status and code) so this file stays free of the API client.
  const e = error as { status?: unknown; code?: unknown } | null;
  return !!e && typeof e === "object" && e.status === 403 && e.code === "FEATURE_NOT_IN_PLAN";
}

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
    case "paused":
      // A problem with the salon's WhatsApp account or Meta's template: the
      // clients not yet reached are waiting for "Reanudar".
      return {
        text: "Pausada",
        tone: "amber",
        detail: `Pausada: ${c.lastError ?? "Meta ha dejado de aceptar los mensajes de esta campaña."}`,
      };
    case "completed": {
      if (c.lastError) return { text: "Sin destinatarios", tone: "gray", detail: c.lastError };
      const when = c.completedAt ? formatDate(c.completedAt) : undefined;
      if (c.failed > 0) {
        const failed = `${c.failed} de ${c.totalRecipients} no se ${c.failed === 1 ? "pudo" : "pudieron"} enviar.`;
        return { text: "Enviada con errores", tone: "amber", detail: when ? `${when} · ${failed}` : failed };
      }
      return { text: "Enviada", tone: "green", detail: when };
    }
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

/**
 * Which actions a campaign allows in its current state. Without a plan that
 * includes campaigns, only stopping and deleting are left.
 */
export function campaignActions(c: WhatsAppCampaign, planIncludes = true) {
  return {
    edit: planIncludes && c.status === "draft",
    submit: planIncludes && c.status === "draft",
    resume: planIncludes && c.status === "paused",
    cancel: c.status === "scheduled" || c.status === "sending" || c.status === "paused",
    remove: c.status !== "sending",
  };
}

/** The counts line under a campaign that started sending; null before that. */
export function campaignStats(c: WhatsAppCampaign): string | null {
  const started = c.status === "sending" || c.status === "paused" || c.status === "completed" || c.status === "cancelled";
  if (!started || c.totalRecipients <= 0) return null;
  const parts = [
    `${c.totalRecipients} destinatarios`,
    `${c.sent} enviados`,
    `${c.delivered} entregados`,
    `${c.read} leídos`,
    `${c.failed} fallidos`,
    `${c.optedOut} bajas`,
  ];
  if ((c.status === "sending" || c.status === "paused") && (c.pending ?? 0) > 0) {
    parts.push(`${c.pending} pendientes`);
  }
  return parts.join(" · ");
}

const NAME_TOKEN = "{{nombre}}";
const GREETING = `Hola ${NAME_TOKEN}, `;
const WORD_CHAR = /[A-Za-z0-9À-ÖØ-öø-ÿ]/;

/**
 * "Insertar {{nombre}}": puts the name where the cursor is. Meta refuses a
 * text that starts or ends with the name, so with the cursor at the start or
 * the end (or an empty message) it greets instead: "Hola {{nombre}}, ..."
 * at the start, merged with a "Hola" already there. Returns the new text and
 * where the cursor goes; a text that already has the name is left alone.
 */
export function insertName(body: string, start: number, end: number = start): { body: string; cursor: number } {
  if (/\{\{\s*nombre\s*\}\}/i.test(body)) return { body, cursor: start };
  const from = Math.max(0, Math.min(start, end, body.length));
  const to = Math.min(body.length, Math.max(start, end, from));
  const before = body.slice(0, from);
  const after = body.slice(to);

  if (before.trim() === "" || after.trim() === "") {
    let rest = body.trimStart();
    const hola = /^hola\b[\s,!.]*/i.exec(rest);
    if (hola) rest = rest.slice(hola[0].length);
    return { body: GREETING + rest, cursor: GREETING.length };
  }

  const insert =
    (WORD_CHAR.test(before.slice(-1)) || /[,.;:!?]$/.test(before) ? " " : "") +
    NAME_TOKEN +
    (WORD_CHAR.test(after.charAt(0)) ? " " : "");
  return { body: before + insert + after, cursor: before.length + insert.length };
}
