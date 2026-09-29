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
