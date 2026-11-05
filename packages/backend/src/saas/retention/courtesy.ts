import { DAY_MS } from "./salon-retention";

/**
 * "Cortesía" from the console (audit 8 D6, owner's decision 2026-11-04):
 * a salon active without paying, on a plan and until a date the platform
 * owner chooses. It replaces the old "Reactivar" without payment.
 *
 * - It is not paying: out of MRR and the paying count (PAYING_TENANT_WHERE
 *   needs a Stripe subscription), and the never-paid email cap still applies
 *   (hasPaidKiraRoom).
 * - 3 days before the end the owner is emailed; at the end it goes read-only
 *   like any salon that left (30 days, then anonymised), by CourtesyScheduler.
 * - A salon that subscribes in Stripe meanwhile simply stops being a courtesy.
 */

/** The owner is emailed this many days before the courtesy ends. */
export const COURTESY_WARNING_DAYS = 3;

/** The longest courtesy the console gives at once. */
export const COURTESY_MAX_DAYS = 366;

export const COURTESY_MESSAGES = {
  untilPast: "La cortesía necesita una fecha de fin posterior a hoy.",
  untilTooFar: `La cortesía puede durar como mucho ${COURTESY_MAX_DAYS} días; si hace falta más, se renueva al acabar.`,
  paysInStripe: "Este salón paga en Stripe: no necesita cortesía.",
  blocked: "Este salón está bloqueado: desbloquéalo antes de darle cortesía.",
  planNeeded: "Elige el plan de la cortesía.",
} as const;

/** Why a courtesy until `until` cannot be given now, or null. */
export function courtesyUntilProblem(until: Date, now: Date = new Date()): string | null {
  if (!(until instanceof Date) || Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) {
    return COURTESY_MESSAGES.untilPast;
  }
  if (until.getTime() - now.getTime() > COURTESY_MAX_DAYS * DAY_MS) return COURTESY_MESSAGES.untilTooFar;
  return null;
}

export interface CourtesyCandidate {
  id: string;
  subscriptionStatus: string;
  stripeSubscriptionId: string | null;
  courtesyUntil: Date | null;
  courtesyWarnedAt: Date | null;
}

export type CourtesyStep = "warn" | "expire" | "converted" | null;

/**
 * What CourtesyScheduler does for one salon now:
 * - converted: it subscribed in Stripe; the courtesy fields are cleared;
 * - expire: the end date has passed; read-only from now;
 * - warn: within COURTESY_WARNING_DAYS of the end and not warned yet.
 */
export function courtesyStep(t: CourtesyCandidate, now: Date): CourtesyStep {
  if (!t.courtesyUntil) return null;
  if (t.stripeSubscriptionId) return "converted";
  if (t.subscriptionStatus !== "active") return null;
  if (t.courtesyUntil.getTime() <= now.getTime()) return "expire";
  if (!t.courtesyWarnedAt && t.courtesyUntil.getTime() - now.getTime() <= COURTESY_WARNING_DAYS * DAY_MS) return "warn";
  return null;
}
