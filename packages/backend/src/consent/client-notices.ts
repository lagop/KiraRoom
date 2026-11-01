import type { PrismaService } from "../common/prisma/prisma.service";
import { DEFAULT_PREFERENCES } from "../notifications/notification-defaults";

/**
 * Does the salon have its own WhatsApp number connected, the sender of the
 * appointment notice templates? The booking page and the widget offer
 * "Recibir los avisos de mi cita por WhatsApp" only then. False on any error:
 * the box is then not offered, and the booking goes on.
 */
export async function salonWhatsAppConnected(
  prisma: Pick<PrismaService, "whatsAppConnection">,
  tenantId: string,
): Promise<boolean> {
  try {
    const conn = await prisma.whatsAppConnection.findUnique({
      where: { tenantId },
      select: { isActive: true, phoneNumberId: true },
    });
    return !!(conn?.isActive && conn.phoneNumberId);
  } catch {
    return false;
  }
}

/**
 * A client's appointment notices -- confirmation, cancellation, change and
 * the 24 h and 1 h reminders -- by channel.
 *
 * They are NotificationPreference rows per notice type (the old account page
 * let a client set every type and channel). Clients have no accounts, so
 * the salon sets them from the client file, one switch per channel for the
 * whole group: these are the types the senders check for an appointment
 * (AppointmentsService confirmations, cancellations and changes, which all
 * ask "appointment_confirmed" or "appointment_cancelled", and the
 * NotificationsScheduler reminders).
 */
export const APPOINTMENT_NOTICE_TYPES = [
  "appointment_confirmed",
  "appointment_cancelled",
  "appointment_reminder_24h",
  "appointment_reminder_1h",
] as const;

export const NOTICE_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];

export type NoticeChannels = Record<NoticeChannel, boolean>;

type Prefs = Record<string, Record<string, boolean | undefined> | undefined>;

function channelOn(prefs: Prefs, type: string, channel: NoticeChannel): boolean {
  return prefs[type]?.[channel] ?? DEFAULT_PREFERENCES[type]?.[channel] ?? true;
}

/**
 * Can the platform send SMS? The same test as SmsService.isConfigured, read
 * from the environment so the consent module need not load the sender.
 */
export function smsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.TWILIO_ACCOUNT_SID?.startsWith("AC") && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
}

/**
 * Which channels the client gets her appointment notices by. A channel is on
 * only when it is on for every notice of the group (as the senders would
 * read it, defaults included).
 */
export function noticeChannelsOf(stored: unknown): NoticeChannels {
  const prefs = (stored && typeof stored === "object" ? stored : {}) as Prefs;
  const out = {} as NoticeChannels;
  for (const channel of NOTICE_CHANNELS) {
    out[channel] = APPOINTMENT_NOTICE_TYPES.every((type) => channelOn(prefs, type, channel));
  }
  return out;
}

/**
 * The preferences with these channels set for every appointment notice; the
 * other notice types and channels are left as they were.
 */
export function withNoticeChannels(stored: unknown, changes: Partial<NoticeChannels>): Prefs {
  const prefs = { ...((stored && typeof stored === "object" ? stored : {}) as Prefs) };
  for (const type of APPOINTMENT_NOTICE_TYPES) {
    const row = { ...(prefs[type] ?? {}) };
    for (const channel of NOTICE_CHANNELS) {
      if (typeof changes[channel] === "boolean") row[channel] = changes[channel];
    }
    prefs[type] = row;
  }
  return prefs;
}
