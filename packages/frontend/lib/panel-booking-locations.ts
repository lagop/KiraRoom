/**
 * The salon's locations in the panel (multi-local): booking a new
 * appointment, editing or moving one, and the agenda's location filter.
 *
 * The data is GET /appointments/booking-locations: the salon's locations and
 * where each professional works. A salon with fewer than two bookable
 * locations gets none, and then every helper here is a no-op: no picker, no
 * filter, nothing sent, exactly as before.
 *
 * The server decides the rest: with no location sent, an appointment goes
 * to its professional's main location (appointment-location.ts); with one,
 * every professional of the visit must work there (400 otherwise).
 */
import type { BookingLocations } from "./api";

export type { BookingLocations };

export const NO_BOOKING_LOCATIONS: BookingLocations = { locations: [], professionals: [] };

/** Whether the salon has a choice of locations (the pickers show). */
export function hasLocations(data: BookingLocations | null | undefined): boolean {
  return !!data && data.locations.length >= 2;
}

/** Where a professional works: no ids for one without locations. */
export function locationsOfProfessional(
  data: BookingLocations,
  professionalId: string | null | undefined,
): { locationIds: string[]; primaryLocationId: string | null } {
  const row = professionalId ? data.professionals.find((p) => p.id === professionalId) : undefined;
  return { locationIds: row?.locationIds ?? [], primaryLocationId: row?.primaryLocationId ?? null };
}

/**
 * A professional's main location: their primary one, or the only one they
 * have, as the server picks it. Null when unknown (the server decides).
 */
export function mainLocationOf(data: BookingLocations, professionalId: string | null | undefined): string | null {
  const { locationIds, primaryLocationId } = locationsOfProfessional(data, professionalId);
  if (primaryLocationId && locationIds.includes(primaryLocationId)) return primaryLocationId;
  return locationIds.length === 1 ? locationIds[0] : null;
}

/** Whether a professional works at a location. Always true without a choice of locations. */
export function worksAt(data: BookingLocations, professionalId: string | null | undefined, locationId: string | null | undefined): boolean {
  if (!hasLocations(data) || !locationId || !professionalId) return true;
  return locationsOfProfessional(data, professionalId).locationIds.includes(locationId);
}

/** The professionals to offer at a location: all of them when none is picked. */
export function professionalsAtLocation<P extends { id: string }>(
  professionals: P[],
  data: BookingLocations,
  locationId: string | null | undefined,
): P[] {
  if (!hasLocations(data) || !locationId) return professionals;
  return professionals.filter((p) => worksAt(data, String(p.id), locationId));
}

/** A location's name, for the hint under the picker. */
export function locationName(data: BookingLocations, locationId: string | null | undefined): string | null {
  return data.locations.find((l) => l.id === locationId)?.name ?? null;
}

/**
 * New appointment: the locationId to send. The one picked, when the salon
 * has a choice; nothing otherwise (the server takes the professional's main
 * location, which is also what the picker's first option says).
 */
export function locationForNewBooking(data: BookingLocations, picked: string | null | undefined): string | undefined {
  if (!hasLocations(data) || !picked) return undefined;
  return data.locations.some((l) => l.id === picked) ? picked : undefined;
}

/**
 * Picking another location for a new booking: the professionals already
 * chosen who do not work there are cleared, so the form never sends a pair
 * the server refuses.
 */
export function keepIfWorksAt(data: BookingLocations, professionalId: string | null | undefined, locationId: string | null | undefined): string {
  return professionalId && worksAt(data, professionalId, locationId) ? professionalId : "";
}

/**
 * Editing an appointment: where it is now. Its own location, or (an older
 * one, saved before appointments had one) its professional's main one.
 */
export function currentLocationOf(
  data: BookingLocations,
  appointment: { locationId?: string | null; professionalId?: string | null } | null | undefined,
): string {
  if (!hasLocations(data) || !appointment) return "";
  return appointment.locationId || mainLocationOf(data, appointment.professionalId) || "";
}

/**
 * Editing: another professional picked. The appointment stays where it is
 * when they work there too, else it goes to their main location -- the
 * same rule as the server's.
 */
export function locationAfterProfessionalChange(
  data: BookingLocations,
  currentLocationId: string,
  professionalId: string,
): string {
  if (!hasLocations(data)) return currentLocationId;
  if (currentLocationId && worksAt(data, professionalId, currentLocationId)) return currentLocationId;
  return mainLocationOf(data, professionalId) ?? currentLocationId;
}

/**
 * Editing: the locationId to send. Nothing when it did not change (or the
 * salon has no choice), so a plain edit never touches it.
 */
export function locationForEdit(
  data: BookingLocations,
  before: string,
  after: string,
): string | undefined {
  if (!hasLocations(data) || !after || after === before) return undefined;
  return after;
}

/** The agenda's filter: an appointment's location, or its professional's main one. */
export function appointmentLocation(
  data: BookingLocations,
  appointment: { locationId?: string | null; professionalId?: string | null },
): string | null {
  return appointment.locationId || mainLocationOf(data, appointment.professionalId);
}

/** The agenda's filter: the appointments at a location; all of them with none picked. */
export function appointmentsAtLocation<A extends { locationId?: string | null; professionalId?: string | null }>(
  appointments: A[],
  data: BookingLocations,
  locationId: string | null | undefined,
): A[] {
  if (!hasLocations(data) || !locationId) return appointments;
  return appointments.filter((a) => appointmentLocation(data, a) === locationId);
}

/**
 * The agenda's columns at a location: the professionals who work there,
 * and anyone with an appointment there that day (moved there from another
 * location), so no appointment is left without its column.
 */
export function columnsAtLocation<P extends { id: string }>(
  professionals: P[],
  data: BookingLocations,
  locationId: string | null | undefined,
  appointmentsThere: ReadonlyArray<{ professionalId?: string | null }>,
): P[] {
  if (!hasLocations(data) || !locationId) return professionals;
  const busy = new Set(appointmentsThere.map((a) => a.professionalId).filter(Boolean) as string[]);
  return professionals.filter((p) => worksAt(data, String(p.id), locationId) || busy.has(String(p.id)));
}
