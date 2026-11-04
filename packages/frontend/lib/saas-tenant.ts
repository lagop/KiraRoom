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

/** What the console's status buttons work on (audit 8 D4, D6). */
export interface TenantActionState {
  subscriptionStatus: string;
  deletedAt?: string | null;
  anonymizedAt?: string | null;
  blockedAt?: string | null;
  /** The salon pays in Stripe (the API sends a yes/no, never the id). */
  hasStripeSubscription?: boolean;
}

export type TenantAction = "suspend" | "courtesy" | "block" | "unblock";

/**
 * The console's buttons for a salon, in order:
 * - Suspender (ends the subscription) while it is not read-only yet;
 * - Cortesía while it does not pay in Stripe (also to extend one);
 * - Bloquear / Desbloquear.
 * A deleted or anonymised salon has none; a blocked one only Desbloquear.
 */
export function tenantActions(t: TenantActionState): TenantAction[] {
  if (t.deletedAt || t.anonymizedAt) return [];
  if (t.blockedAt) return ["unblock"];
  const out: TenantAction[] = [];
  const readOnly = isReadOnlyStatus(t.subscriptionStatus);
  if (!readOnly) out.push("suspend");
  if (readOnly || !t.hasStripeSubscription) out.push("courtesy");
  out.push("block");
  return out;
}

/** The longest courtesy the API gives at once (courtesy.ts, COURTESY_MAX_DAYS). */
export const COURTESY_MAX_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-12-04": the date input's value, `days` from now in Spain. */
export function dateInputValue(from: Date, days = 0): string {
  const d = new Date(from.getTime() + days * DAY_MS);
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}

/**
 * The courtesy end sent to the API: the end of the chosen day in Spain
 * (23:59), so "hasta el 4 de diciembre" includes the 4th. Null for an
 * empty or malformed value.
 */
export function courtesyUntilIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T23:59:00+01:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Why the chosen courtesy end cannot be sent ("past", "too_far"), or null. */
export function courtesyUntilProblem(value: string, now: Date = new Date()): "missing" | "past" | "too_far" | null {
  const iso = courtesyUntilIso(value);
  if (!iso) return "missing";
  const t = new Date(iso).getTime();
  if (t <= now.getTime()) return "past";
  if (t - now.getTime() > COURTESY_MAX_DAYS * DAY_MS) return "too_far";
  return null;
}

/**
 * The statuses the edit form offers (audit 8 T13, D4, D6): its own, and
 * "En prueba" while not read-only (extending a trial). Leaving read-only or
 * running without paying is "Cortesía"; ending it is "Suspender"; past_due
 * and suspended come from Stripe.
 */
export function editableStatuses(current: string): string[] {
  if (!current) return [];
  if (isReadOnlyStatus(current) || current === "trialing" || current === "past_due") return [current];
  return [current, "trialing"];
}
