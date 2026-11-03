/**
 * How a notice in the bell and on /dashboard/notifications is shown: where a
 * click takes you, how old it reads, and its type's label key.
 *
 * Both used to be in English ("Just now", "Schedule Change", "Mark all
 * read"), and a click only marked the notice read: the time-off answer
 * ("Mis ausencias" says "te avisamos en las notificaciones") and every
 * booking notice carried a link or an appointment id nobody could open.
 */

export interface NotificationLike {
  type: string;
  data?: Record<string, unknown> | null;
}

/**
 * Where a click on the notice goes, or null. `data.link` when it is a path
 * inside the panel (never another site), else the appointment it is about,
 * opened in the agenda's drawer.
 */
export function notificationHref(n: NotificationLike): string | null {
  const data = n.data ?? {};
  const link = typeof data.link === "string" ? data.link.trim() : "";
  if (link.startsWith("/dashboard") && !link.startsWith("//")) return link;
  const appointmentId = typeof data.appointmentId === "string" ? data.appointmentId.trim() : "";
  if (appointmentId) {
    return `/dashboard/appointments?appointment=${encodeURIComponent(appointmentId)}`;
  }
  return null;
}

export type RelativeTime =
  | { key: "just_now" }
  | { key: "minutes" | "hours" | "days" | "weeks"; count: number }
  | { key: "date"; date: Date };

export function relativeTime(dateString: string, now: Date = new Date()): RelativeTime {
  const date = new Date(dateString);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return { key: "just_now" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: "hours", count: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { key: "days", count: days };
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return { key: "weeks", count: weeks };
  return { key: "date", date };
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** "hace 5 minutos" / "5 minutes ago", or the date in the panel's language. */
export function formatRelativeTime(dateString: string, t: Translate, now: Date = new Date()): string {
  const r = relativeTime(dateString, now);
  if (r.key === "just_now") return t("notifications.time.just_now");
  if (r.key === "date") {
    return r.date.toLocaleDateString(t("notifications.locale"), { day: "numeric", month: "short", year: "numeric" });
  }
  const plural = r.count === 1 ? "one" : "other";
  return t(`notifications.time.${r.key}_${plural}`, { count: r.count });
}

const TYPE_LABELS = new Set([
  "appointment_created",
  "appointment_reminder",
  "appointment_reminder_24h",
  "appointment_reminder_1h",
  "appointment_confirmed",
  "appointment_completed",
  "appointment_cancelled",
  "appointment_rescheduled",
  "appointment_no_show",
  "new_appointment_assigned",
  "schedule_change",
  "payment_received",
  "payment_failed",
  "refund_processed",
  "promotion",
  "special_offer",
  "system_alert",
  "account_update",
  "password_change",
  "new_message",
  "review_request",
  "news",
  "waitlist_slot_available",
]);

/** The message key of the type's label ("Cita nueva", "Cambio de horario"...). */
export function notificationTypeLabelKey(type: string): string {
  return TYPE_LABELS.has(type) ? `notifications.types.${type}` : "notifications.types.other";
}

export const NOTIFICATION_TYPES_WITH_LABEL: ReadonlyArray<string> = Array.from(TYPE_LABELS);
