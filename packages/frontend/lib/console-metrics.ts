/**
 * Formatting for the platform console's figures (audit 8 D3, D11; T8).
 *
 * Every amount the console shows is already in euros: MRR, and the salons'
 * takings (Appointment.price is a Decimal in euros). The pages used to
 * divide the takings by 100 as if they were cents.
 */

const EUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });

/** 1234.5 -> "1234,50 €" (es-ES). A missing value reads as 0. */
export function formatEuros(value: number | null | undefined): string {
  return EUR.format(Number.isFinite(value as number) ? (value as number) : 0);
}

/** 12.345 -> "12,3 %"; null (nothing to compare with) -> "—". */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

/** "+12,3 %" / "-4,0 %" / "—": a change, with its sign. */
export function formatChange(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPercent(value)}`;
}

/** "2026-11" -> "nov" (Spanish short month, no trailing dot). */
export function formatMonthShort(month: string): string {
  const [year, m] = month.split("-").map(Number);
  if (!year || !m) return month;
  return new Date(Date.UTC(year, m - 1, 15))
    .toLocaleDateString("es-ES", { month: "short", timeZone: "UTC" })
    .replace(".", "");
}

/** "ES" -> "España"; an unknown code is shown as is. */
export function countryName(code: string): string {
  try {
    const names = new Intl.DisplayNames(["es"], { type: "region" });
    return names.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
