import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, map } from "rxjs";

/**
 * What an appointment response may carry.
 *
 * Appointment queries include the client, the professional and the tenant
 * whole (`include: { client: true, tenant: true, ... }`), and the responses
 * returned them as they came. That sent, among other things:
 * - the salon's Stripe secret keys (stored in plain text on the tenant) and
 *   the channel tokens kept in `tenant.features`;
 * - the client's password hash.
 * The public booking endpoint returned all of it to anyone who booked, and
 * since a booking attaches to the existing client with that email or phone,
 * booking with someone's phone number returned their record.
 */

/** The tenant fields an appointment response may show. */
const PUBLIC_TENANT_FIELDS = [
  "id",
  "name",
  "slug",
  "logo",
  "email",
  "phone",
  "timezone",
  "currency",
  "language",
  "minCancelHours",
] as const;

/** Never sent, wherever they appear in a response. */
const SECRET_FIELDS = new Set([
  "passwordHash",
  "stripeTestSecretKey",
  "stripeLiveSecretKey",
  "emailVerificationToken",
  "twoFactorSecret",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  // Dates, Prisma Decimals and the like are values, not records to walk.
  return proto === Object.prototype || proto === null;
}

function pickTenant(tenant: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_TENANT_FIELDS) {
    if (key in tenant) out[key] = tenant[key];
  }
  return out;
}

/** A copy of `value` without secrets: any `tenant` reduced to its public fields. */
export function scrubSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key)) continue;
    out[key] = key === "tenant" && isPlainObject(field) ? pickTenant(field) : scrubSecrets(field);
  }
  return out as T;
}

/** Applies scrubSecrets to everything a controller returns. */
@Injectable()
export class ScrubSecretsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => scrubSecrets(body)));
  }
}

/**
 * The answer to a public booking: what the person who booked needs to see,
 * and nothing about the client record it was attached to or the salon.
 */
export function publicBooking(appointment: any) {
  return {
    id: appointment.id,
    status: appointment.status,
    scheduledDate: appointment.scheduledDate,
    scheduledTime: appointment.scheduledTime,
    service: appointment.service
      ? { id: appointment.service.id, name: appointment.service.name, duration: appointment.service.duration }
      : null,
    professional: appointment.professional
      ? {
          id: appointment.professional.id,
          firstName: appointment.professional.firstName,
          lastName: appointment.professional.lastName,
        }
      : null,
  };
}
