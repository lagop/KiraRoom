/**
 * What happens to the data of a salon that left (audit 7 D7, decided by the
 * owner on 2026-11-04):
 *
 *   1. Its trial or subscription ends (or the owner asks to delete it): 30
 *      days of read-only, to export everything (BillingScheduler,
 *      SubscriptionsService.cancelSubscription; READ_ONLY_DAYS).
 *   2. 7 days before the end of the next 30 days, the owner is emailed.
 *   3. 60 days in all after it ended, its personal data is anonymised
 *      (GdprService.anonymize with keepFiscalData), and a GdprRequest records
 *      it. A trial that never paid follows the same rule.
 *
 * The same periods are written in the terms, the privacy policy, the
 * marketing pricing FAQ and the read-only notice and emails: change them
 * together.
 *
 * Pure functions here; the job is salon-retention.scheduler.ts.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Read-only after the end, to export (BillingScheduler and cancelSubscription use 30 too). */
export const READ_ONLY_DAYS = 30;

/** Then this many days more until the personal data is anonymised: 60 in all. */
export const ANONYMIZE_AFTER_READ_ONLY_DAYS = 30;

/** The owner is warned this many days before. */
export const ANONYMIZE_WARNING_DAYS = 7;

/**
 * How long issued invoices and their fiscal data are kept. Retention never
 * touches them: anonymising keeps every invoice, its recipient and the
 * salon's NIF and razón social. 4 years is the tax limitation period (art. 66
 * LGT); the Código de Comercio (art. 30) asks 6 for the books. The owner is
 * confirming the figure with the gestor: nothing deletes invoices yet, and
 * the legal texts say 4.
 */
export const INVOICE_RETENTION_YEARS = 4;

/** The env flag that lets the job anonymise for real. Off (dry run) unless "true". */
export const RETENTION_FLAG = "RETENTION_ANONYMIZE_ENABLED";

export function retentionEnabled(value: string | undefined | null): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

/** When a salon read-only until `readOnlyUntil` is anonymised. */
export function anonymizationDate(readOnlyUntil: Date): Date {
  return new Date(readOnlyUntil.getTime() + ANONYMIZE_AFTER_READ_ONLY_DAYS * DAY_MS);
}

/** A salon the job looks at: read-only, not deleted, not anonymised. */
export interface RetentionCandidate {
  id: string;
  name: string;
  subscriptionStatus: string;
  readOnlyUntil: Date | null;
  anonymizationWarnedAt: Date | null;
  anonymizationWarnedFor: Date | null;
}

export type RetentionStep =
  | { kind: "warn"; tenantId: string; anonymizeOn: Date }
  | { kind: "anonymize"; tenantId: string; anonymizeOn: Date };

const sameInstant = (a: Date | null, b: Date | null) => !!a && !!b && a.getTime() === b.getTime();

/**
 * What the job does for one salon now, or null:
 * - warn: within ANONYMIZE_WARNING_DAYS of the date and not yet warned for
 *   this read-only period (a salon that came back and left again is warned
 *   again);
 * - anonymize: the date has passed AND the owner was warned for this period
 *   at least ANONYMIZE_WARNING_DAYS ago. A salon never warned (the job was
 *   off, the email failed) is warned first and anonymised a week later, so
 *   nobody loses data without the 7 days' notice.
 */
export function retentionStep(t: RetentionCandidate, now: Date): RetentionStep | null {
  if (t.subscriptionStatus !== "cancelled" && t.subscriptionStatus !== "suspended") return null;
  if (!t.readOnlyUntil) return null;
  const anonymizeOn = anonymizationDate(t.readOnlyUntil);
  const warnFrom = anonymizeOn.getTime() - ANONYMIZE_WARNING_DAYS * DAY_MS;
  if (now.getTime() < warnFrom) return null;

  const warned = sameInstant(t.anonymizationWarnedFor, t.readOnlyUntil) && !!t.anonymizationWarnedAt;
  if (!warned) {
    // Warned late: the 7 days run from now, and the email says so.
    const earliest = new Date(now.getTime() + ANONYMIZE_WARNING_DAYS * DAY_MS);
    return { kind: "warn", tenantId: t.id, anonymizeOn: earliest > anonymizeOn ? earliest : anonymizeOn };
  }

  const noticeServed = now.getTime() - t.anonymizationWarnedAt!.getTime() >= ANONYMIZE_WARNING_DAYS * DAY_MS;
  if (now.getTime() >= anonymizeOn.getTime() && noticeServed) {
    return { kind: "anonymize", tenantId: t.id, anonymizeOn };
  }
  return null;
}
