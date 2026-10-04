/**
 * A WhatsApp campaign's message as a Meta template.
 *
 * Outside the 24-hour window that a client's own message opens, WhatsApp
 * only delivers messages built from a template Meta approved, and
 * promotions must be MARKETING templates. So each campaign becomes a
 * template on the salon's own WhatsApp Business account: the salon writes
 * the text, with {{nombre}} where the client's first name goes, and Meta
 * reviews it (from minutes to a day) before anything is sent.
 */

/** Meta's limit for a template body. */
export const MAX_BODY_LENGTH = 1024;

/**
 * The footer every campaign carries: how to stop, in the words the webhook
 * understands (whatsapp.service.ts). Meta caps footers at 60 characters and
 * allows no variables in them.
 */
export const CAMPAIGN_FOOTER = "Responde BAJA si no quieres más promociones";

const NAME_PLACEHOLDER = /\{\{\s*nombre\s*\}\}/gi;

export interface CompiledBody {
  /** The body as Meta takes it, with {{1}} for the name. */
  text: string;
  usesName: boolean;
}

/**
 * Turns the salon's text into a template body, or says in Spanish why Meta
 * would refuse it. The checks are Meta's documented rules for template
 * bodies: length, known variables only, and no variable at the very start
 * or end of the text.
 */
export function compileBody(raw: string): CompiledBody | { error: string } {
  const source = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!source) return { error: "Escribe el mensaje de la campaña." };

  const names = source.match(NAME_PLACEHOLDER) ?? [];
  if (names.length > 1) return { error: "Usa {{nombre}} una sola vez en el mensaje." };
  const text = source.replace(NAME_PLACEHOLDER, "{{1}}");

  if (/\{\{(?!1\}\})/.test(text) || /\{\{1\}\}[\s\S]*\{\{/.test(text)) {
    return { error: "El único marcador permitido es {{nombre}}." };
  }
  if (text.startsWith("{{1}}") || text.endsWith("{{1}}")) {
    return { error: "El mensaje no puede empezar ni terminar con {{nombre}}: añade texto antes y después." };
  }
  if (text.length > MAX_BODY_LENGTH) {
    return { error: `El mensaje tiene ${text.length} caracteres; WhatsApp admite ${MAX_BODY_LENGTH} como máximo.` };
  }
  if (/\n{3,}/.test(text)) {
    return { error: "Deja como mucho una línea en blanco seguida." };
  }
  return { text, usesName: names.length === 1 };
}

/**
 * The template's name on the salon's account: lowercase letters, digits and
 * underscores, unique per campaign and per submission (a rejected name
 * cannot simply be sent again with other text).
 */
export function templateNameFor(campaignId: string, attempt: number): string {
  const id = campaignId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12);
  return `kr_promo_${id}_${attempt}`;
}

/** The submission number a template name was made with (0 when it has none). */
export function attemptOf(templateName: string | null | undefined): number {
  const match = /_(\d+)$/.exec(templateName ?? "");
  return match ? Number(match[1]) : 0;
}

/** What Meta's template-creation endpoint receives. */
export function campaignTemplatePayload(name: string, body: CompiledBody) {
  return {
    name,
    language: "es",
    category: "MARKETING",
    components: [
      {
        type: "BODY",
        text: body.text,
        ...(body.usesName ? { example: { body_text: [["Ana"]] } } : {}),
      },
      { type: "FOOTER", text: CAMPAIGN_FOOTER },
    ],
  };
}

/** Promotions go out between 9:00 and 21:00 in the salon's time zone. */
export const SEND_FROM_HOUR = 9;
export const SEND_UNTIL_HOUR = 21;

/** Whether `now` is inside the sending hours where the salon is. */
export function withinSendingHours(now: Date, timeZone: string): boolean {
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now),
    );
  } catch {
    hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Madrid" }).format(now));
  }
  return hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
}
