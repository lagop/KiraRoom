/**
 * Pure helpers for the salon site's account settings page
 * (app/sites/[salonName]/account/settings). Everything the page shows as
 * saved comes from the server; these only work out what changed and what
 * to send.
 */

export type NotificationChannel = "inApp" | "email" | "sms" | "whatsapp";

export type ChannelPrefs = Partial<Record<NotificationChannel, boolean>>;
export type NotificationPrefs = Record<string, ChannelPrefs>;

/** The notification types the page lets a client tune. */
export const NOTIFICATION_TYPES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "appointment_confirmed", label: "Cita confirmada" },
  { key: "appointment_cancelled", label: "Cita cancelada" },
  { key: "appointment_reminder_24h", label: "Recordatorio 24 h antes" },
  { key: "appointment_reminder_1h", label: "Recordatorio 1 h antes" },
  { key: "appointment_completed", label: "Cita completada" },
  { key: "review_request", label: "Solicitud de valoración" },
  { key: "promotion", label: "Promociones" },
  { key: "news", label: "Novedades" },
  { key: "special_offer", label: "Ofertas especiales" },
];

/** A channel reads as on when any notification type uses it. */
export function channelEnabled(prefs: NotificationPrefs, channel: NotificationChannel): boolean {
  return NOTIFICATION_TYPES.some((t) => prefs[t.key]?.[channel] === true);
}

/** Turns a channel on or off for every notification type. */
export function setChannel(
  prefs: NotificationPrefs,
  channel: NotificationChannel,
  enabled: boolean,
): NotificationPrefs {
  const next: NotificationPrefs = { ...prefs };
  for (const t of NOTIFICATION_TYPES) {
    next[t.key] = { ...(prefs[t.key] ?? {}), [channel]: enabled };
  }
  return next;
}

export interface ProfileFields {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** The fields that differ from what the server has, trimmed. */
export function profileChanges(saved: ProfileFields, form: ProfileFields): Partial<ProfileFields> {
  const out: Partial<ProfileFields> = {};
  (Object.keys(form) as Array<keyof ProfileFields>).forEach((k) => {
    const value = form[k].trim();
    if (value !== (saved[k] ?? "").trim()) out[k] = value;
  });
  return out;
}

/** Changing the sign-in email needs the current password (the server checks it). */
export function emailChangeNeedsPassword(saved: ProfileFields, form: ProfileFields): boolean {
  return form.email.trim() !== (saved.email ?? "").trim();
}

export function samePrefs(a: NotificationPrefs, b: NotificationPrefs): boolean {
  return NOTIFICATION_TYPES.every((t) =>
    (["inApp", "email", "sms", "whatsapp"] as NotificationChannel[]).every(
      (c) => (a[t.key]?.[c] ?? false) === (b[t.key]?.[c] ?? false),
    ),
  );
}
