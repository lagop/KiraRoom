/**
 * How the Promociones page shows a promotion and what it sends back. Kept
 * apart from the page so it is tested (promotions-format.spec.ts): money and
 * dates the Spanish way ("5,00 €", "2 nov 2026"), only the types the form
 * can create, and a code that does not change once created.
 */

export type PromotionTypeKey = "PERCENTAGE" | "FIXED" | "BUY_X_GET_Y";

/** What the form can create. "Compra X lleva Y" has no fields to say X or Y. */
export const CREATABLE_PROMOTION_TYPES: Array<{ value: PromotionTypeKey; label: string }> = [
  { value: "PERCENTAGE", label: "Porcentaje" },
  { value: "FIXED", label: "Importe fijo" },
];

export function promotionTypeLabel(type: string): string {
  return CREATABLE_PROMOTION_TYPES.find((t) => t.value === type)?.label ?? "Otro";
}

/** 5 -> "5,00 €" (euros, not cents). */
export function formatEuros(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(
    typeof n === "number" && Number.isFinite(n) ? n : 0,
  );
}

/** "10 %" or "5,00 €". */
export function discountLabel(type: string, value: number | string): string {
  return type === "PERCENTAGE" ? `${Number(value)} %` : formatEuros(value);
}

/**
 * "2 nov 2026". The start and end dates are calendar days stored as their
 * UTC midnight, so they are read in UTC: never the day before.
 */
export function formatPromotionDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export interface PromotionFormValues {
  name: string;
  description: string;
  code: string;
  type: string;
  value: string;
  minOrderValue: string;
  maxUses: string;
  maxUsesPerClient: string;
  startDate: string;
  endDate: string;
}

/**
 * The body for POST /promotions or PUT /promotions/:id. On an edit the code
 * is left out: it is what clients were given, and the server keeps it.
 */
export function promotionPayload(form: PromotionFormValues, editing: boolean) {
  const int = (v: string) => (v.trim() === "" ? null : parseInt(v, 10));
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    ...(editing ? {} : { code: form.code.trim().toUpperCase() }),
    type: form.type,
    value: parseFloat(form.value),
    minOrderValue: parseFloat(form.minOrderValue) || 0,
    maxUses: int(form.maxUses),
    maxUsesPerClient: int(form.maxUsesPerClient),
    startDate: form.startDate,
    endDate: form.endDate || null,
  };
}
