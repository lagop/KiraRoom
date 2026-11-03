/**
 * The bell and the notifications page: where a click goes, and the texts in
 * Spanish and English.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/notification-display.spec.ts
 */
import es from "../messages/es.json";
import en from "../messages/en.json";
import {
  NOTIFICATION_TYPES_WITH_LABEL,
  formatRelativeTime,
  notificationHref,
  notificationTypeLabelKey,
  relativeTime,
} from "./notification-display";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

console.log("notificationHref");
check(
  "the time-off answer opens its page (data.link)",
  notificationHref({ type: "schedule_change", data: { link: "/dashboard/mis-ausencias" } }),
  "/dashboard/mis-ausencias",
);
check(
  "a booking notice opens the appointment in the agenda",
  notificationHref({ type: "appointment_created", data: { appointmentId: "a-1" } }),
  "/dashboard/appointments?appointment=a-1",
);
check(
  "a link wins over the appointment",
  notificationHref({ type: "schedule_change", data: { link: "/dashboard/solicitudes-ausencia", appointmentId: "a-1" } }),
  "/dashboard/solicitudes-ausencia",
);
check("never another site", notificationHref({ type: "news", data: { link: "https://example.com/x" } }), null);
check("never a protocol-relative link", notificationHref({ type: "news", data: { link: "//example.com" } }), null);
check("nothing to open: null", notificationHref({ type: "system_alert", data: {} }), null);
check("no data at all: null", notificationHref({ type: "system_alert" }), null);

console.log("relativeTime");
const now = new Date("2026-11-03T12:00:00.000Z");
check("under a minute", relativeTime("2026-11-03T11:59:30.000Z", now), { key: "just_now" });
check("minutes", relativeTime("2026-11-03T11:55:00.000Z", now), { key: "minutes", count: 5 });
check("hours", relativeTime("2026-11-03T10:00:00.000Z", now), { key: "hours", count: 2 });
check("days", relativeTime("2026-11-01T12:00:00.000Z", now), { key: "days", count: 2 });
check("weeks", relativeTime("2026-10-20T12:00:00.000Z", now), { key: "weeks", count: 2 });
check("older: the date", relativeTime("2026-09-01T12:00:00.000Z", now).key, "date");

function translator(messages: any) {
  return (key: string, params?: Record<string, unknown>) => {
    let v: any = messages;
    for (const k of key.split(".")) v = v?.[k];
    if (typeof v !== "string") return key;
    return v.replace(/\{(\w+)\}/g, (_: string, p: string) => String(params?.[p] ?? `{${p}}`));
  };
}
const tEs = translator(es);
const tEn = translator(en);
check("Spanish: hace 2 horas", formatRelativeTime("2026-11-03T10:00:00.000Z", tEs, now), "hace 2 horas");
check("Spanish: hace 1 minuto", formatRelativeTime("2026-11-03T11:59:00.000Z", tEs, now), "hace 1 minuto");
check("English: 2 hours ago", formatRelativeTime("2026-11-03T10:00:00.000Z", tEn, now), "2 hours ago");
check("Spanish: Ahora mismo", formatRelativeTime("2026-11-03T12:00:00.000Z", tEs, now), "Ahora mismo");

console.log("labels in both languages");
const keys = [
  ...NOTIFICATION_TYPES_WITH_LABEL.map((type) => notificationTypeLabelKey(type)),
  notificationTypeLabelKey("something_new"),
  "notifications.title",
  "notifications.mark_all_read",
  "notifications.mark_read",
  "notifications.empty",
  "notifications.empty_unread",
  "notifications.load_error",
  "notifications.retry",
  "notifications.view_all",
  "notifications.loading_more",
  "notifications.no_more",
  "notifications.end",
  "notifications.filter_all",
  "notifications.filter_unread",
  "notifications.summary",
  "notifications.summary_unread",
  "notifications.open",
  "notifications.locale",
  "notifications.time.just_now",
  "notifications.time.minutes_one",
  "notifications.time.minutes_other",
  "notifications.time.hours_one",
  "notifications.time.hours_other",
  "notifications.time.days_one",
  "notifications.time.days_other",
  "notifications.time.weeks_one",
  "notifications.time.weeks_other",
];
const missingEs = keys.filter((k) => tEs(k) === k);
const missingEn = keys.filter((k) => tEn(k) === k);
check("every key is in es.json", missingEs, []);
check("every key is in en.json", missingEn, []);
check("rescheduled reads in Spanish", tEs(notificationTypeLabelKey("appointment_rescheduled")), "Cita cambiada");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
