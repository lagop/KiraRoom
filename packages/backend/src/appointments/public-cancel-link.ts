import { createHmac, timingSafeEqual } from "crypto";

/**
 * The client's "Cancelar mi cita" link, in the confirmation email and SMS of
 * a booking made online (the salon page, the widget, the chat receptionist).
 *
 * The token is the appointment id, signed (HMAC-SHA256 with a key derived
 * for this use only, 128 bits kept), so it cannot be guessed or made for
 * another appointment. It carries no personal data. It stops working once
 * the appointment has started or is no longer live: that is checked against
 * the appointment itself, so a moved appointment keeps its link.
 *
 * Kept short on purpose: it goes in an SMS. A uuid is sent as its 16 bytes.
 */

const SIGNATURE_CHARS = 22;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signature(payload: string, secret: string): string {
  const key = createHmac("sha256", secret).update("appointment-cancel:v1").digest();
  return createHmac("sha256", key).update(payload).digest("base64url").slice(0, SIGNATURE_CHARS);
}

export function appointmentCancelToken(appointmentId: string, secret: string): string {
  if (!UUID.test(appointmentId)) throw new Error("appointment id is not a uuid");
  const payload = Buffer.from(appointmentId.replace(/-/g, ""), "hex").toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

/** The appointment id a token names, or null when it is malformed or not ours. */
export function parseAppointmentCancelToken(token: string, secret: string): string | null {
  const [payload, sig, extra] = String(token ?? "").split(".");
  if (!payload || !sig || extra !== undefined || !secret) return null;
  const expected = Buffer.from(signature(payload, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const hex = Buffer.from(payload, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The public page the link opens; null without a signing secret or for a non-uuid id. */
export function appointmentCancelUrl(appointmentId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.JWT_SECRET;
  if (!secret || !UUID.test(appointmentId)) return null;
  const appBase = (env.APP_BASE_URL || env.FRONTEND_URL || "https://app.kiraroom.net").replace(/\/+$/, "");
  return `${appBase}/public/cita/${appointmentCancelToken(appointmentId, secret)}`;
}

/** Bookings whose notices carry the link: those the client made herself, online. */
export function bookedOnline(appointment: { source?: string | null }): boolean {
  return appointment?.source === "online" || appointment?.source === "widget";
}
