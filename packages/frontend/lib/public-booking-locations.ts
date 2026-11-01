/**
 * The location step of the public booking page (multi-local).
 *
 * A salon with two or more locations to book at sends them with its page
 * (`locations`, backend multi-location/client-locations.ts), and each
 * professional says where they work. The client then picks the location
 * first -- or picks a professional and the location follows from them -- and
 * the form offers only the services and professionals of that location; the
 * slots and the booking carry its id, and the confirmation gives its
 * address. A salon with one location sends none, and nothing here changes
 * its page.
 *
 * No React here, so lib/public-booking-locations.spec.ts can run it.
 */
import type { PublicSalonLocation } from "./salon-seo";

export interface LocatedProfessional {
  id: string;
  locationIds?: string[];
  primaryLocationId?: string | null;
  services?: Array<{ serviceId?: string; service?: { id: string } }>;
}

/** The locations to choose from; none (no location step) unless there are two or more. */
export function bookingLocations(page: { locations?: PublicSalonLocation[] | null }): PublicSalonLocation[] {
  const locations = page.locations ?? [];
  return locations.length >= 2 ? locations : [];
}

/**
 * The location a link names: `?locationId=<id>`, or `?location=<slug or id>`
 * (the readable one to put on a poster at the door). Empty when it names
 * none of the salon's locations.
 */
export function locationFromQuery(q: URLSearchParams, locations: PublicSalonLocation[]): string {
  if (locations.length === 0) return "";
  const wanted = (q.get("locationId") || q.get("location") || "").trim().toLowerCase();
  if (!wanted) return "";
  const match = locations.find((l) => l.id.toLowerCase() === wanted || l.slug.toLowerCase() === wanted);
  return match?.id ?? "";
}

/**
 * Who does the service: the professionals linked to it, or everyone when
 * nobody is (as the server books: an unbookable page is the worse failure).
 * No service yet: nobody.
 */
export function professionalsForService<T extends LocatedProfessional>(professionals: T[], serviceId: string): T[] {
  if (!serviceId) return [];
  const linked = professionals.filter((p) =>
    (p.services ?? []).some((link) => (link.service?.id ?? link.serviceId) === serviceId),
  );
  return linked.length > 0 ? linked : professionals;
}

/**
 * Who can be booked, given the location step: everyone when there is none;
 * with a location chosen, who works there; with the step but nothing chosen
 * yet, who works at any of them (picking one sets the location).
 */
export function professionalsAtLocation<T extends LocatedProfessional>(
  professionals: T[],
  locations: PublicSalonLocation[],
  locationId: string,
): T[] {
  if (locations.length === 0) return professionals;
  const offered = new Set(locations.map((l) => l.id));
  return professionals.filter((p) =>
    (p.locationIds ?? []).some((id) => offered.has(id) && (!locationId || id === locationId)),
  );
}

/**
 * The services that can be booked at the chosen location: those someone who
 * works there does. Who does a service is decided salon-wide first, as the
 * server does, then narrowed to the location. Every service when there is no
 * location step or none is chosen yet.
 */
export function servicesAtLocation<S extends { id: string }, T extends LocatedProfessional>(
  services: S[],
  professionals: T[],
  locations: PublicSalonLocation[],
  locationId: string,
): S[] {
  if (locations.length === 0 || !locationId) return services;
  const here = new Set(professionalsAtLocation(professionals, locations, locationId).map((p) => p.id));
  return services.filter((s) => professionalsForService(professionals, s.id).some((p) => here.has(p.id)));
}

/**
 * The location once the client picks a professional: the chosen one when
 * they work there, else their main one, else the first of theirs. Empty when
 * there is no location step.
 */
export function locationForProfessional(
  professional: LocatedProfessional | undefined,
  locations: PublicSalonLocation[],
  current: string,
): string {
  if (locations.length === 0 || !professional) return "";
  const theirs = (professional.locationIds ?? []).filter((id) => locations.some((l) => l.id === id));
  if (current && theirs.includes(current)) return current;
  if (professional.primaryLocationId && theirs.includes(professional.primaryLocationId)) {
    return professional.primaryLocationId;
  }
  return theirs[0] ?? current;
}

/**
 * Ready to ask for times: with a location step, a location must be set (it
 * always is once a professional is picked); without one, nothing more.
 */
export function locationReady(locations: PublicSalonLocation[], locationId: string): boolean {
  return locations.length === 0 || !!locationId;
}

/** The location the booking is at, for the confirmation. */
export function chosenLocation(locations: PublicSalonLocation[], locationId: string): PublicSalonLocation | null {
  return locations.find((l) => l.id === locationId) ?? null;
}
