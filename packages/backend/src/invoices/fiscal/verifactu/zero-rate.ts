/**
 * What a 0 % line of a salon's invoices is for the AEAT, chosen in Ajustes
 * fiscales (fiscalSettings.zeroRateTreatment) when Verifactu is activated.
 *
 *   S1      subject at 0 %
 *   E1-E6   exempt (OperacionExentaType)
 *   N1, N2  not subject (CalificacionOperacionType)
 *   none    the salon does not use the 0 %: such a line is unexpected, and
 *           goes as ZERO_RATE_FALLBACK, flagged for the salon to review
 *
 * Lines at any other rate are always S1. Which one applies is the salon's
 * and its adviser's call: the panel explains the options, it never picks one.
 */
export const OPERATION_CODES = ["S1", "E1", "E2", "E3", "E4", "E5", "E6", "N1", "N2"] as const;
export type OperationCode = (typeof OPERATION_CODES)[number];

export const ZERO_RATE_TREATMENTS = ["none", ...OPERATION_CODES] as const;
export type ZeroRateTreatment = (typeof ZERO_RATE_TREATMENTS)[number];

/**
 * A 0 % line the salon said it does not have. It never stops a sale or a
 * refund (either would roll back the whole operation at the till): S1 says
 * what the invoice says, a tax at 0 %, and claims no exemption nobody chose.
 */
export const ZERO_RATE_FALLBACK: OperationCode = "S1";

/** Whether the salon has said what its 0 % lines are. */
export function zeroRateIsChosen(treatment: ZeroRateTreatment | null): treatment is OperationCode {
  return treatment !== null && treatment !== "none";
}

/** The salon's choice, or null while it has not made one. */
export function zeroRateTreatmentOf(settings: unknown): ZeroRateTreatment | null {
  const value = (settings as { zeroRateTreatment?: unknown } | null | undefined)?.zeroRateTreatment;
  return (ZERO_RATE_TREATMENTS as readonly unknown[]).includes(value) ? (value as ZeroRateTreatment) : null;
}
