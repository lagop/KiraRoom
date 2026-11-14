import { createHmac } from "crypto";
import { Logger } from "@nestjs/common";
import { phoneKey } from "../common/phone";
import { SMS_BOOKING_DIAL_CODES, smsCountryAllowed } from "../notifications/services/sms.service";

// The country list lives beside sendSms, which now refuses any other number
// for every SMS (wait list, reschedule...), not only booking ones.
export { SMS_BOOKING_DIAL_CODES, smsCountryAllowed };

/**
 * Caps on the SMS a booking made from outside the salon sends -- its public
 * page, the embeddable widget, the chat receptionist (bookOnline).
 *
 * Anyone can book online, with any number, and the confirmation SMS went to
 * whatever number was typed. SMS sent for bookings spend no credits, so a
 * bot booking free slots across many salons could make KiraRoom pay for
 * thousands of texts to premium numbers ("SMS pumping"). Per rolling 24 h:
 *
 * - per salon: PUBLIC_BOOKING_SMS_PER_SALON_DAY (default 40) -- far above
 *   what a salon gets from online bookings in a day;
 * - per number, across every salon: PUBLIC_BOOKING_SMS_PER_PHONE_DAY
 *   (default 3).
 *
 * Over a cap the booking still succeeds; its SMS is held back and logged
 * without the number, and so are that booking's SMS reminders (the email
 * and WhatsApp notices are not affected). Any error here holds the SMS back
 * too: fail closed.
 *
 * Only numbers of Spain and the rest of the EU/EEA get these SMS
 * (SMS_BOOKING_DIAL_CODES): premium-rate pumping mostly targets far-off
 * ranges, and the salons' clients are here. Any other number is skipped
 * quietly, recorded as held (reason "country") so its reminders are not
 * texted either.
 *
 * Each decision is a PublicBookingSms row. The number is never stored: an
 * HMAC of its last nine digits is enough to count it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const logger = new Logger("PublicBookingSmsCap");

export interface PublicSmsLimits {
  perSalonPerDay: number;
  perPhonePerDay: number;
}

function limitFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function publicSmsLimits(env: NodeJS.ProcessEnv = process.env): PublicSmsLimits {
  return {
    perSalonPerDay: limitFrom(env.PUBLIC_BOOKING_SMS_PER_SALON_DAY, 40),
    perPhonePerDay: limitFrom(env.PUBLIC_BOOKING_SMS_PER_PHONE_DAY, 3),
  };
}

/** What a number is counted by: an HMAC of its last nine digits, so "600 111 222" and "+34600111222" are one number. */
export function phoneHash(phone: string, secret: string = process.env.JWT_SECRET || "kiraroom"): string {
  const key = createHmac("sha256", secret).update("public-booking-sms:v1").digest();
  return createHmac("sha256", key).update(phoneKey(phone) || phone.replace(/\D/g, "")).digest("hex");
}

interface CapDb {
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/**
 * Whether this public booking's SMS may go out, recorded either way. Under a
 * per-salon and a per-number advisory lock (taken in that order, always), so
 * two bookings at once cannot both take the last place.
 */
export async function reservePublicBookingSms(
  db: CapDb,
  input: { tenantId: string; appointmentId: string; phone: string },
  limits: PublicSmsLimits = publicSmsLimits(),
  now: Date = new Date(),
): Promise<{ allowed: boolean; reason?: "salon" | "phone" | "country" | "error" }> {
  try {
    const hash = phoneHash(input.phone);
    if (!smsCountryAllowed(input.phone)) {
      await (db as any).publicBookingSms.create({
        data: { tenantId: input.tenantId, appointmentId: input.appointmentId, phoneHash: hash, allowed: false, createdAt: now },
      });
      return { allowed: false, reason: "country" };
    }
    return await db.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`public-sms:salon:${input.tenantId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`public-sms:phone:${hash}`}))`;
      const since = new Date(now.getTime() - DAY_MS);
      const [bySalon, byPhone] = await Promise.all([
        tx.publicBookingSms.count({ where: { tenantId: input.tenantId, allowed: true, createdAt: { gt: since } } }),
        tx.publicBookingSms.count({ where: { phoneHash: hash, allowed: true, createdAt: { gt: since } } }),
      ]);
      const reason = bySalon >= limits.perSalonPerDay ? "salon" : byPhone >= limits.perPhonePerDay ? "phone" : undefined;
      await tx.publicBookingSms.create({
        data: {
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
          phoneHash: hash,
          allowed: !reason,
          createdAt: now,
        },
      });
      return reason ? { allowed: false, reason } : { allowed: true };
    });
  } catch (err) {
    logger.warn(`Public booking SMS cap not checked, SMS held back: ${(err as Error).message}`);
    return { allowed: false, reason: "error" };
  }
}

/**
 * For the reminders: whether this appointment's SMS were held back at
 * booking. An appointment with no record (booked in the panel, imported,
 * or before the caps) is not. Fails closed.
 */
export async function publicBookingSmsHeld(
  db: { publicBookingSms: { findFirst(args: any): Promise<unknown> } },
  appointmentId: string,
): Promise<boolean> {
  try {
    return !!(await db.publicBookingSms.findFirst({
      where: { appointmentId, allowed: false },
      select: { id: true },
    }));
  } catch (err) {
    logger.warn(`Public booking SMS record not read, reminder SMS held back: ${(err as Error).message}`);
    return true;
  }
}
