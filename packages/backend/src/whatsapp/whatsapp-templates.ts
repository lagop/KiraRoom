/**
 * The message templates KiraRoom asks Meta to approve on each salon's
 * WhatsApp Business account.
 *
 * Outside the 24-hour window that a client's own message opens, WhatsApp
 * only delivers approved templates. Reminders went out as free text through
 * Twilio, so a reminder sent a day before the appointment -- always outside
 * that window -- was refused. The same happened to the confirmation of an
 * appointment booked by phone or at the desk, to cancellations and to
 * changes: the client had not written in the last 24 hours. These are
 * "utility" templates (the cheapest category, about 0,017 EUR in Spain),
 * submitted when the salon connects its number.
 *
 * Each one ends with an invitation to reply: a reply opens the service
 * window, and the receptionist answers it. Meta refuses templates whose body
 * starts or ends with a variable, so none does.
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

export const APPOINTMENT_CONFIRMED: TemplateDefinition = {
  name: "kiraroom_cita_confirmada",
  language: "es",
  category: "UTILITY",
  body:
    "Hola {{1}}, tu cita en {{2}} está confirmada: {{3}}, el {{4}} a las {{5}}. " +
    "Si necesitas cambiarla o cancelarla, responde a este mensaje.",
  example: ["Ana", "Salón Lucía", "Corte y peinado", "jueves 9 de octubre", "10:30"],
};

export const APPOINTMENT_CANCELLED: TemplateDefinition = {
  name: "kiraroom_cita_cancelada",
  language: "es",
  category: "UTILITY",
  body:
    "Hola {{1}}, tu cita en {{2}} ({{3}}) del {{4}} a las {{5}} ha sido cancelada. " +
    "Si quieres pedir una nueva, responde a este mensaje.",
  example: ["Ana", "Salón Lucía", "Corte y peinado", "jueves 9 de octubre", "10:30"],
};

export const APPOINTMENT_RESCHEDULED: TemplateDefinition = {
  name: "kiraroom_cita_cambiada",
  language: "es",
  category: "UTILITY",
  body:
    "Hola {{1}}, hemos cambiado tu cita en {{2}} ({{3}}). Ahora es el {{4}} a las {{5}}. " +
    "Si no te viene bien, responde a este mensaje.",
  example: ["Ana", "Salón Lucía", "Corte y peinado", "viernes 10 de octubre", "17:00"],
};

export const STANDARD_TEMPLATES: TemplateDefinition[] = [
  APPOINTMENT_REMINDER,
  APPOINTMENT_CONFIRMED,
  APPOINTMENT_CANCELLED,
  APPOINTMENT_RESCHEDULED,
];

/** The body as Meta's template-creation API expects it. */
export function templateCreationPayload(t: TemplateDefinition) {
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    components: [{ type: "BODY", text: t.body, example: { body_text: [t.example] } }],
  };
}

/**
 * A template variable as Meta accepts it: no line breaks or tabs, no more
 * than four spaces in a row, and never empty (the send is refused with
 * "parameter missing").
 */
export function templateParam(value: string | null | undefined, fallback = "-"): string {
  const clean = (value ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return clean || fallback;
}

/** The variables of a template send, in order. */
export function bodyParameters(values: string[]) {
  return [{ type: "body", parameters: values.map((text) => ({ type: "text", text: templateParam(text) })) }];
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
