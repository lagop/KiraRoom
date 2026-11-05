/**
 * What a 0 % line of a salon's invoices is for the AEAT, chosen in Ajustes
 * fiscales (fiscalSettings.zeroRateTreatment) when Verifactu is activated.
 *
 *   S1      subject at 0 %
 *   E1-E6   exempt (OperacionExentaType)
 *   N1, N2  not subject (CalificacionOperacionType)
 *   none    the salon does not use the 0 %: such a line is refused
 *
 * Lines at any other rate are always S1. Which one applies is the salon's
 * and its adviser's call: the panel explains the options, it never picks one.
 */
export const OPERATION_CODES = ["S1", "E1", "E2", "E3", "E4", "E5", "E6", "N1", "N2"] as const;
export type OperationCode = (typeof OPERATION_CODES)[number];

export const ZERO_RATE_TREATMENTS = ["none", ...OPERATION_CODES] as const;
export type ZeroRateTreatment = (typeof ZERO_RATE_TREATMENTS)[number];

/** The salon's choice, or null while it has not made one. */
export function zeroRateTreatmentOf(settings: unknown): ZeroRateTreatment | null {
  const value = (settings as { zeroRateTreatment?: unknown } | null | undefined)?.zeroRateTreatment;
  return (ZERO_RATE_TREATMENTS as readonly unknown[]).includes(value) ? (value as ZeroRateTreatment) : null;
}
