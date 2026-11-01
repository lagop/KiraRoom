/**
 * What a service was when it was booked.
 *
 * The visit totals, the till, the invoice and the notices used to read an
 * appointment's service from the catalog, so editing a service's price or
 * duration changed appointments already made: the next edit of the visit
 * re-priced it, the invoice lines and the agenda took the new figures, the
 * notices the new name. Each appointment, each service row of a visit and
 * each add-on now keeps the name, price (EUROS, like services.price) and
 * duration it was booked with, and every reader goes through the helpers
 * below, which prefer the snapshot and fall back to the live service for
 * rows from before it (history the migration left alone).
 *
 * - Written at booking (insertAppointment and every other path that makes an
 *   appointment or a visit row), and when the salon switches an appointment
 *   or a row to another service: then it is that service's, as it is now.
 * - A reschedule, a new professional, a status change: nothing here moves.
 * - The till may still charge less (a discount): that is the appointment's
 *   price and discount, not its snapshot.
 * - No tax rate: services carry none. The rate is the salon's
 *   (fiscalSettings.defaultTaxRate) on the day the invoice is issued, which is
 *   when Spanish VAT/IGIC is due (the service is rendered), so a rate
 *   changed by law between booking and visit must apply.
 */

/** The live catalog service, as much of it as a reader selected. */
export interface LiveService {
  id?: string;
  name?: string | null;
  price?: unknown;
  duration?: number | null;
  bufferTime?: number | null;
}

/** The snapshot columns, on appointments and on appointment_services. */
export interface ServiceSnapshotColumns {
  serviceName?: string | null;
  servicePrice?: unknown;
  serviceDuration?: number | null;
}

/** The columns to select next to `service` for the snapshot. */
export const SNAPSHOT_SELECT = {
  serviceName: true,
  servicePrice: true,
  serviceDuration: true,
} as const;

/** The snapshot of a catalog service, as columns to write. */
export function snapshotOf(service: { name: string; price: unknown; duration: number }): {
  serviceName: string;
  servicePrice: any;
  serviceDuration: number;
} {
  return {
    serviceName: service.name,
    // Decimal, string or number: Prisma takes any of them for a Decimal.
    servicePrice: service.price as any,
    serviceDuration: service.duration,
  };
}

const present = (v: unknown) => v !== null && v !== undefined;

/**
 * The service as it was booked: the snapshot where there is one, else the
 * live service. The cleanup time (bufferTime) is the agenda's rule today,
 * not part of what was booked, so it stays the live one. Null when there is
 * neither.
 */
export function bookedService(
  row: (ServiceSnapshotColumns & { serviceId?: string | null; service?: LiveService | null }) | null | undefined,
): (LiveService & { name?: string | null }) | null {
  if (!row) return null;
  const live = row.service ?? null;
  if (!live && !present(row.serviceName) && !present(row.servicePrice) && !present(row.serviceDuration)) {
    return null;
  }
  return {
    ...(live ?? {}),
    id: live?.id ?? row.serviceId ?? undefined,
    name: present(row.serviceName) ? row.serviceName : live?.name,
    price: present(row.servicePrice) ? row.servicePrice : live?.price,
    duration: present(row.serviceDuration) ? Number(row.serviceDuration) : live?.duration,
  };
}

/** The booked service's name, for notices and tickets. */
export function bookedServiceName(
  row: (ServiceSnapshotColumns & { service?: { name?: string | null } | null }) | null | undefined,
  fallback: string,
): string {
  return (present(row?.serviceName) ? row!.serviceName : row?.service?.name) || fallback;
}

/**
 * An appointment with its `service` replaced by the booked one, for code
 * that reads `appointment.service.name` / `.price` / `.duration` (notices,
 * the till's ticket). Nothing else changes.
 */
export function withBookedService<T extends ServiceSnapshotColumns & { serviceId?: string; service?: LiveService | null }>(
  apt: T,
): T {
  if (!apt) return apt;
  const booked = bookedService(apt);
  return booked ? { ...apt, service: { ...(apt.service ?? {}), ...booked } } : apt;
}

/* -------------------------------------------------------------------------- */
/*  Add-ons                                                                   */
/* -------------------------------------------------------------------------- */

/** An add-on line of `appointments.addons`, with what it was added at. */
export interface AddonSnapshot {
  addonId: string;
  quantity: number;
  name?: string;
  price?: number;
  duration?: number;
}

/**
 * The add-on lines to store: each keeps the snapshot it already had (the
 * same add-on, still on the visit, is not re-priced when another changes),
 * and a new one takes the catalog's now. `previous` is the stored list,
 * `catalog` the services the new lines name.
 */
export function snapshotAddons(
  lines: Array<{ addonId: string; quantity: number }>,
  previous: Array<AddonSnapshot>,
  catalog: Array<{ id: string; name?: string | null; price?: unknown; duration?: number | null }>,
): AddonSnapshot[] {
  return lines.map((l) => {
    const before = previous.find((p) => p.addonId === l.addonId && present(p.price));
    if (before) {
      return { addonId: l.addonId, quantity: l.quantity, name: before.name, price: before.price, duration: before.duration };
    }
    const live = catalog.find((c) => c.id === l.addonId);
    if (!live) return { addonId: l.addonId, quantity: l.quantity };
    const price = Number(live.price ?? 0);
    return {
      addonId: l.addonId,
      quantity: l.quantity,
      ...(live.name ? { name: live.name } : {}),
      price: Number.isFinite(price) ? price : 0,
      duration: Number(live.duration) || 0,
    };
  });
}

/** An add-on's service as it was added: its snapshot, else the live one. */
export function bookedAddon(
  line: AddonSnapshot,
  live: { id?: string; name?: string | null; price?: unknown; duration?: number | null } | null | undefined,
): { id?: string; name?: string | null; price?: unknown; duration?: number | null } | null {
  if (!present(line.price)) return live ?? null;
  return {
    id: live?.id ?? line.addonId,
    name: line.name ?? live?.name,
    price: line.price,
    duration: present(line.duration) ? line.duration : live?.duration,
  };
}
