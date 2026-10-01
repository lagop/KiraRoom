/**
 * Whether invoices may be sent to the tax authorities (Verifactu,
 * TicketBAI, SII).
 *
 * Not yet in production. The transports are stubs that answer "accepted"
 * with references like CSV-STUB-…, so a salon that switched Verifactu on
 * saw its invoices marked as accepted by the AEAT when nothing had been
 * sent; the "real" mode posts without the mutual-TLS certificate, and the
 * hash chain does not follow the AEAT specification. Telling a salon it
 * complies when it does not is worse than not offering the feature.
 *
 * Development and tests keep the stubs. Production needs
 * FISCAL_SUBMISSION_ENABLED=1, which should only be set once the real
 * implementation is done and certified.
 */
export function fiscalSubmissionAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || env.FISCAL_SUBMISSION_ENABLED === "1";
}

export const FISCAL_SUBMISSION_UNAVAILABLE =
  "El envío de facturas a la AEAT (Verifactu, TicketBAI o SII) todavía no está disponible en KiraRoom. " +
  "Puedes emitir facturas; no se envían a Hacienda.";
