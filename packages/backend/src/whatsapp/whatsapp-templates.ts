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
 * The wait-list notice: the client asked to be told when a slot opens, so
 * it is a utility message about their own request. Meta refuses a body that
 * starts or ends with a variable, hence the closing sentence.
 */
export const WAITLIST_SLOT_AVAILABLE: TemplateDefinition = {
  name: "kiraroom_hueco_libre",
  language: "es",
  category: "UTILITY",
  body:
    "Hola {{1}}, se ha liberado un hueco en {{2}} para {{3}}: {{4}}. " +
    "Puedes reservarlo aquí: {{5}} . Se asigna a quien reserve primero.",
  example: [
    "Ana",
    "Salón Lucía",
    "Corte y peinado",
    "jueves 9 de octubre a las 10:30",
    "https://app.kiraroom.net/sites/salon-lucia",
  ],
};

export const STANDARD_TEMPLATES: TemplateDefinition[] = [APPOINTMENT_REMINDER, WAITLIST_SLOT_AVAILABLE];

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
