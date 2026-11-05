/**
 * The rules a salon's reviews follow, shared by the service, the panel and
 * the public pages. Pure, tested in review-rules.spec.ts.
 *
 * What is shown, and why (consumer law asks a business that shows reviews to
 * say how it handles them, and not to drop the bad ones silently):
 * - every answered rating counts in the salon's average, except a review the
 *   salon rejected for one of the listed reasons;
 * - a review is listed on the salon's site, with the client's first name and
 *   initial, only once approved (or after MODERATION_GRACE_DAYS without a
 *   decision) and only if she ticked the consent box;
 * - the salon can reject or hide one only for a listed reason, and who did
 *   it and when is kept.
 */

/** The only reasons a review can be rejected or hidden for. */
export const REVIEW_REJECTION_REASONS = ["offensive", "personal_data", "off_topic", "spam"] as const;
export type ReviewRejectionReason = (typeof REVIEW_REJECTION_REASONS)[number];

/** Rejections from before reasons were required (migration 20261102100000). */
export const LEGACY_REJECTION_REASON = "legacy_unspecified" as const;

export const REJECTION_REASON_LABEL: Record<ReviewRejectionReason | typeof LEGACY_REJECTION_REASON, string> = {
  offensive: "Insultos o contenido ofensivo",
  personal_data: "Datos personales",
  off_topic: "No habla del servicio",
  spam: "Spam o duplicada",
  legacy_unspecified: "Sin motivo (anterior)",
};

export function isRejectionReason(value: unknown): value is ReviewRejectionReason {
  return typeof value === "string" && (REVIEW_REJECTION_REASONS as readonly string[]).includes(value);
}

/**
 * A review the salon has not approved or rejected within this many days of
 * the client sending it is published anyway: the site says every review is
 * published unless it breaks the rules, so leaving one in the queue cannot
 * be a way to hide it.
 */
export const MODERATION_GRACE_DAYS = 7;

/** The consent box on the review page, unticked. */
export const PUBLISH_CONSENT_TEXT = "Pueden mostrar mi opinión en su web con mi nombre e inicial";
/** Bumped whenever PUBLISH_CONSENT_TEXT (or what it covers) changes. */
export const PUBLISH_CONSENT_VERSION = "2026-11-02";

export type PublishConsent = "granted" | "declined" | "legacy" | "anonymised";
/**
 * Listed publicly: she ticked the box, or answered under the old notice that
 * said approved reviews would appear with her name and initial.
 */
export const LISTABLE_CONSENTS: PublishConsent[] = ["granted", "legacy"];

/**
 * Review requests go out only in these hours of the salon's own clock
 * (09:00 to 20:59): a message at 3 a.m. is a bad first impression.
 */
export const SENDING_HOURS = { from: 9, to: 21 } as const;

/** The hour (0-23) at `now` on the salon's clock; Europe/Madrid when the zone is unknown. */
export function salonHour(now: Date, timeZone: string | null | undefined): number {
  const format = (tz: string) =>
    Number(
      new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz })
        .formatToParts(now)
        .find((p) => p.type === "hour")?.value,
    );
  try {
    return format(timeZone || "Europe/Madrid");
  } catch {
    return format("Europe/Madrid");
  }
}

export function withinSendingHours(now: Date, timeZone: string | null | undefined): boolean {
  const hour = salonHour(now, timeZone);
  return hour >= SENDING_HOURS.from && hour < SENDING_HOURS.to;
}
