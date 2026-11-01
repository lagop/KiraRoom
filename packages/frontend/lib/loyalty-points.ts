/**
 * Points as the panel shows them (tested in loyalty-points.spec.ts):
 *
 *   - Expiry: a member's whole balance expires after a period with no paid
 *     visit or purchase; each one renews all of it. The salon picks the
 *     period (12 months by default) or "No caducan".
 *   - A balance can be negative: a refund took back points the client had
 *     already spent. Staff see it in red with why; she cannot redeem until
 *     her next visits pay it off.
 */

/** The periods offered on the Fidelización screen, in days. null: points never expire. */
export const EXPIRY_DAY_OPTIONS: Array<number | null> = [180, 365, 540, 730, null];

/** The period in months (365 days: 12), or null for a period that is not whole months. */
export function expiryMonths(days: number | null | undefined): number | null {
  if (!days || days <= 0) return null;
  if (days % 365 === 0) return (days / 365) * 12;
  if (days % 30 === 0) return days / 30;
  return null;
}

/** "12 meses", "45 días": the period as the rule says it. */
export function expiryPeriodText(days: number): string {
  const months = expiryMonths(days);
  if (months !== null) return months === 1 ? "1 mes" : `${months} meses`;
  return days === 1 ? "1 día" : `${days} días`;
}

/** The rule as the client reads it on the ticket and in the emails (the server writes the same). */
export function expiryRuleText(days: number | null | undefined): string | null {
  if (!days || days <= 0) return null;
  return `Tus puntos caducan si pasan ${expiryPeriodText(days)} sin visitas`;
}

/** The options of the period selector: the standard ones, plus the salon's own if it is another. */
export function expiryOptions(current: number | null | undefined): Array<number | null> {
  if (current == null || EXPIRY_DAY_OPTIONS.includes(current)) return EXPIRY_DAY_OPTIONS;
  const days = [...EXPIRY_DAY_OPTIONS.filter((d): d is number => d !== null), current].sort((a, b) => a - b);
  return [...days, null];
}

/** Whether a balance is a debt (shown in red, no redeeming). */
export function isNegativeBalance(points: number | null | undefined): boolean {
  return typeof points === "number" && points < 0;
}

/** The class of a balance: red when negative. */
export function balanceClass(points: number | null | undefined): string {
  return isNegativeBalance(points) ? "text-red-700" : "";
}
