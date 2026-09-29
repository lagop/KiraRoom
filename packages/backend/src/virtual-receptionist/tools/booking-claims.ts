/**
 * Does this reply tell the client an appointment exists?
 *
 * Found in an end-to-end chat on a test salon: after a summary the model had
 * written itself (without propose_appointment), the client said "Sí,
 * perfecto" and the model answered "¡Excelente! Tu cita está confirmada"
 * with no tool call at all -- and no appointment in the database. The prompt
 * forbids exactly that; the model did it anyway. So the orchestrator checks
 * every reply against what the tools actually did.
 */

const CLAIM = [
  /\b(tu|la|su) (cita|reserva) (esta|ha sido|queda|ya esta) (confirmada|registrada|reservada|hecha|agendada|lista)\b/,
  /\b(cita|reserva) (confirmada|registrada|reservada|agendada)\b/,
  /\bhe (reservado|registrado|confirmado|agendado)\b/,
  /\bqueda(s)? (reservad[oa]|confirmad[oa]|apuntad[oa])\b/,
  /\bte esperamos\b/,
  /\b(your )?(appointment|booking) (is|has been) (confirmed|booked|registered|made)\b/,
  /\bi(ve| have) (booked|confirmed|registered)\b/,
  /\byou(re| are) (all set|booked)\b/,
  // "Excelente, entonces tienes la cita para el viernes a las 16:30 ✅" --
  // said on choosing the time, before anything was proposed or booked.
  /\btienes (la|tu) cita (para|el|a las|reservada|confirmada)\b/,
  // "Perfecto, las 15:00 del miércoles 7 de octubre está reservado", on
  // choosing the time. Not "ya está reservada": that is how a taken slot is
  // described.
  /(?<!\bya )\b(esta|queda) reservad[oa]\b/,
];
const NEGATED = /\b(no|todavia no|aun no|not|not yet)\b[^.!?\n]{0,30}\b(confirmada|registrada|reservada|hecha|confirmed|booked|registered|made)\b/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’*_]/g, '')
    .replace(/\s+/g, ' ');
}

export function claimsBooking(reply: string): boolean {
  const text = normalize(reply);
  if (NEGATED.test(text)) return false;
  return CLAIM.some((re) => re.test(text));
}

/**
 * Does this reply present a booking summary for the client to confirm?
 *
 * A summary is only worth a "yes" if propose_appointment recorded it. In a
 * real chat the model wrote the summary itself -- with Carmen as the
 * professional -- the client said yes, there was nothing to book, and the
 * proposal it then made without a professional was booked with someone else.
 */
const ASKS_TO_CONFIRM = /\b(es (todo )?correcto|confirmas|todo bien|lo confirmo|is (this|that|everything) (correct|right)|do you confirm|shall i book)\b/;
const FIELD_LABELS = [
  /\bservicio\s*:/, /\bfecha\s*:/, /\bhora\s*:/, /\bnombre\s*:/, /\bemail\s*:/,
  /\bservice\s*:/, /\bdate\s*:/, /\btime\s*:/, /\bname\s*:/,
];

export function looksLikeSummary(reply: string): boolean {
  const text = normalize(reply);
  if (!ASKS_TO_CONFIRM.test(text)) return false;
  if (/\b(resumen|summary)\b/.test(text)) return true;
  // Without the word: "Voy a confirmar tu reserva con los datos que tengo:
  // Servicio: ... Fecha: ... Hora: ... ¿Es todo correcto?" -- written by the
  // model with "Profesional: Por asignar", and nothing to book on "sí".
  return FIELD_LABELS.filter((re) => re.test(text)).length >= 3;
}
