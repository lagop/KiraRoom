/**
 * Whether invoices may be sent to the tax authorities (Verifactu,
 * TicketBAI, SII).
 *
 * Not in production until FISCAL_SUBMISSION_ENABLED=1, which opens VERI*FACTU
 * (verifactu/config.ts) once it has been tested against the AEAT's test
 * environment and the declaración responsable is signed. TicketBAI and SII
 * are still stubs that answer "accepted" with references like CSV-STUB-…: the
 * settings refuse them in production whatever the flag says.
 *
 * Development and tests keep the stubs.
 */
export function fiscalSubmissionAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || env.FISCAL_SUBMISSION_ENABLED === "1";
}

export const FISCAL_SUBMISSION_UNAVAILABLE =
  "El envío de facturas a la AEAT (Verifactu, TicketBAI o SII) todavía no está disponible en KiraRoom. " +
  "Puedes emitir facturas; no se envían a Hacienda.";
