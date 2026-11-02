/**
 * Ajustes > Recordatorios, "Últimos recordatorios enviados": how each row of
 * GET /rebooking/log is shown. The card used to be wired to nothing (always
 * "—"), and would have printed client and service ids and ISO dates.
 *
 * No React and no Next imports, so lib/rebooking-log.spec.ts can run it.
 */

/** "1 nov 2026, 10:05" in the salon's timezone, not the browser's. */
export function formatSalonDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("es-ES", {
      timeZone,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    // An unknown timezone name: Madrid, the default salon timezone.
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }
}

/** The message key of a reminder channel (rebooking.settings.channel*). */
export function rebookingChannelKey(channel: string): string {
  if (channel === "whatsapp") return "rebooking.settings.channelWhatsapp";
  if (channel === "both") return "rebooking.settings.channelBoth";
  return "rebooking.settings.channelEmail";
}

const STATUSES = new Set(["scheduled", "sent", "cancelled", "failed", "booked"]);

/** The message key of a reminder status (rebooking.status.*). */
export function rebookingStatusKey(status: string): string {
  return STATUSES.has(status) ? `rebooking.status.${status}` : "rebooking.status.unknown";
}
