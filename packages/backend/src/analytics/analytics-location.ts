/**
 * Analítica for one location (Empresa, D12): which appointments and till
 * lines belong to it.
 *
 * An appointment belongs to the location it was booked at. Older rows of
 * professionals with several locations have none, and then the location is
 * where the professional works (their only active location, or their primary
 * one): the same rule as Multi-local's consolidated report
 * (multi-location/consolidated-report.ts), so both screens give one location
 * the same figures.
 *
 * Till sales have no location. A service sold at the till belongs to the
 * location of the professional who did it; products cannot be placed, so
 * they are left out while a location is chosen.
 */

import { LocationLink, homeLocations } from "../multi-location/consolidated-report";

export interface LocationScope {
  locationId: string;
  name: string;
  /** Professionals whose home is this location (homeLocations). */
  professionalIds: string[];
}

/** The scope of `location`, from the salon's professional-location links. */
export function locationScopeOf(
  location: { id: string; name: string },
  links: ReadonlyArray<LocationLink>,
  activeLocationIds: ReadonlyArray<string>,
): LocationScope {
  // A closed location still has its history: it counts as active here.
  const homes = homeLocations(links, new Set([...activeLocationIds, location.id]));
  const professionalIds = [...homes].filter(([, loc]) => loc === location.id).map(([id]) => id).sort();
  return { locationId: location.id, name: location.name, professionalIds };
}

/**
 * The Prisma filter for the appointments of a scope (none without one): booked
 * at the location, or with no location and a professional who works there.
 */
export function appointmentLocationWhere(scope: LocationScope | undefined): Record<string, unknown> {
  if (!scope) return {};
  return {
    OR: [
      { locationId: scope.locationId },
      { locationId: null, professionalId: { in: scope.professionalIds } },
    ],
  };
}

/**
 * The till lines of a scope: only services, by the location's professionals.
 * Without a scope, every product and service line.
 */
export function tillLocationWhere(
  scope: LocationScope | undefined,
  kinds: ReadonlyArray<string>,
): Record<string, unknown> {
  if (!scope) return { kind: { in: [...kinds] } };
  return { kind: "service", professionalId: { in: scope.professionalIds } };
}

/** A location id as the API takes it: a UUID. */
export function isLocationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
