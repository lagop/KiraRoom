/**
 * The message templates KiraRoom asks Meta to approve on each salon's
 * WhatsApp Business account.
 *
 * Outside the 24-hour window that a client's own message opens, WhatsApp
 * only delivers approved templates. Reminders went out as free text through
 * Twilio, so a reminder sent a day before the appointment -- always outside
 * that window -- was refused. These are "utility" templates (the cheapest
 * category, about 0,017 EUR in Spain), submitted when the salon connects
 * its number.
 *
 * The reminder ends with an invitation to reply: a reply opens the service
 * window, and the receptionist answers it.
 */
export interface TemplateDefinition {
  name: string;
  language: string;
  category: "UTILITY";
  body: string;
  /** Sample values Meta requires to review the variables. */
  example: string[];
}

export const APPOINTMENT_REMINDER: TemplateDefinition = {
  name: "kiraroom_recordatorio_cita",
  language: "es",
  category: "UTILITY",
  body:
    "Hola {{1}}, te recordamos tu cita en {{2}}: {{3}}, el {{4}} a las {{5}}. " +
    "Si no puedes venir o quieres cambiarla, responde a este mensaje.",
  example: ["Ana", "Salón Lucía", "Corte y peinado", "jueves 9 de octubre", "10:30"],
};

/**
 * The review request sent a few hours after a completed appointment (the
 * google_reviews_auto add-on). It is about that specific visit, which is what
 * keeps it a utility message; if Meta files it as marketing instead it still
 * works once approved, only at the marketing price. A template body may not
 * end with a variable, hence the closing sentence after the link.
 */
export const REVIEW_REQUEST: TemplateDefinition = {
  name: "kiraroom_opinion_cita",
  language: "es",
  category: "UTILITY",
  body:
    "Hola {{1}}, gracias por tu visita a {{2}} ({{3}}). ¿Nos cuentas qué tal fue? " +
    "Puedes valorarla en un minuto aquí: {{4}} . ¡Gracias por ayudarnos a mejorar!",
  example: ["Ana", "Salón Lucía", "Corte y peinado", "https://app.kiraroom.net/public/r/abc123"],
};

export const STANDARD_TEMPLATES: TemplateDefinition[] = [APPOINTMENT_REMINDER, REVIEW_REQUEST];

/** The body as Meta's template-creation API expects it. */
export function templateCreationPayload(t: TemplateDefinition) {
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    components: [{ type: "BODY", text: t.body, example: { body_text: [t.example] } }],
  };
}

/** The variables of a template send, in order. */
export function bodyParameters(values: string[]) {
  return [{ type: "body", parameters: values.map((text) => ({ type: "text", text })) }];
}

/** "jueves 9 de octubre", for a date-only value stored at UTC midnight. */
export function spanishDate(date: Date): string {
  return new Intl.DateTimeFormat("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date);
}
