/**
 * Shared bits of the SaaS console's salon pages (audit 8): one map of
 * subscription statuses with the panel's names, the address autofill of
 * "Crear salón", Spanish dates, and the typed-name check of the GDPR
 * erasure. Pure, tested in saas-tenant.spec.ts.
 */

export type TenantStatus = "active" | "trialing" | "past_due" | "suspended" | "cancelled";

const STATUSES: readonly TenantStatus[] = ["active", "trialing", "past_due", "suspended", "cancelled"];

/**
 * The es.json key of a status: the same names everywhere (T18). "cancelled"
 * used to read "Cancelada" in the list and "Suspended" on the salon's page,
 * past_due "Pendiente". Unknown statuses fall back to their own text.
 */
export function tenantStatusKey(status: string | null | undefined): string | null {
  return STATUSES.includes(status as TenantStatus) ? `saas.console.status_${status}` : null;
}

export const TENANT_STATUS_CLASS: Record<TenantStatus, string> = {
  active: "bg-indigo-100 text-indigo-800",
  trialing: "bg-blue-100 text-blue-800",
  past_due: "bg-yellow-100 text-yellow-800",
  suspended: "bg-orange-100 text-orange-800",
  cancelled: "bg-red-100 text-red-800",
};

export function tenantStatusClass(status: string | null | undefined): string {
  return TENANT_STATUS_CLASS[status as TenantStatus] ?? "bg-gray-100 text-gray-800";
}

/** Read-only statuses: the salon can look, not change (as read-only-tenant.guard). */
export function isReadOnlyStatus(status: string | null | undefined): boolean {
  return status === "cancelled" || status === "suspended";
}

/**
 * The web address made from a name, as the backend's slugify: accents
 * folded ("Salón Lucía" is salon-lucia), at most 63 characters.
 */
export function slugFromName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

export interface SlugField {
  slug: string;
  /** The operator typed the address: the name stops filling it. */
  touched: boolean;
}

/**
 * The address after a keystroke in the name or the address field (T7). The
 * form used to fill it "while empty", checked against the state before the
 * key, so it stopped after the first letter and the salon was left at "s".
 */
export function nextSlugField(prev: SlugField, field: "name" | "slug", value: string): SlugField {
  if (field === "slug") return { slug: value, touched: value.trim() !== "" };
  return prev.touched ? prev : { slug: slugFromName(value), touched: false };
}

/** "4 nov 2026" (Spain's time), or "—". */
export function formatDateEs(value: string | Date | null | undefined, withTime = false): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-ES", {
    timeZone: "Europe/Madrid",
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

/** The typed confirmation of the erasure: same name, ignoring case, accents and spaces (as the API). */
export function sameSalonName(typed: string, name: string): boolean {
  const norm = (s: string) =>
    (s ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return norm(typed).length > 0 && norm(typed) === norm(name);
}

/** Whether the erasure needs "Anonimizar aunque esté activo" (T5): the API refuses otherwise. */
export function anonymizeNeedsForce(t: { subscriptionStatus: string; deletedAt?: string | null; anonymizedAt?: string | null }): boolean {
  return !t.deletedAt && !t.anonymizedAt && !isReadOnlyStatus(t.subscriptionStatus);
}

/** Resend is offered for pending and expired invites (the API makes a fresh link). */
export function inviteCanResend(status: string): boolean {
  return status === "pending" || status === "expired";
}

export function inviteCanRevoke(status: string): boolean {
  return status === "pending";
}
