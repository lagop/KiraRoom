/**
 * The salon's locations as a client sees them: on the public booking page,
 * in the virtual receptionist and in the appointment emails.
 *
 * A salon with one location (or none) books exactly as before: nothing here
 * shows up. With two or more, the client picks where (or it follows from the
 * professional), availability and booking take that locationId
 * (professional-locations.ts), and the notices say which location and its
 * address.
 *
 * Only locations someone can be booked at count: an open location with at
 * least one active professional assigned to it. A second location created in
 * the panel but with nobody assigned yet does not turn the booking page into
 * a two-step form whose second option has nobody to book.
 */

export interface ClientLocationRow {
  id: string;
  name: string;
  slug: string;
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
}

export interface ClientLocation extends ClientLocationRow {
  /** The active professionals who work there. */
  professionalIds: string[];
}

export interface LocationLinkRow {
  professionalId: string;
  locationId: string;
  isPrimary: boolean;
}

/** The part of a Prisma client these helpers read. */
export interface ClientLocationsDb {
  location: { findMany(args: any): Promise<any[]> };
  professionalLocation: { findMany(args: any): Promise<any[]> };
}

export const CLIENT_LOCATION_SELECT = {
  id: true,
  name: true,
  slug: true,
  street: true,
  city: true,
  state: true,
  postalCode: true,
  phone: true,
} as const;

/**
 * The locations a client chooses from: the salon's open locations that have
 * an active professional, in name order -- or none at all when there are
 * fewer than two (one location is no choice). `links` are the professionals'
 * links to those locations, for "where does this professional work".
 */
export async function clientLocations(
  db: ClientLocationsDb,
  tenantId: string,
): Promise<{ locations: ClientLocation[]; links: LocationLinkRow[] }> {
  const [rows, allLinks] = await Promise.all([
    db.location.findMany({
      where: { tenantId, isActive: true },
      select: CLIENT_LOCATION_SELECT,
      orderBy: [{ name: "asc" }],
    }) as Promise<ClientLocationRow[]>,
    db.professionalLocation.findMany({
      where: {
        location: { tenantId, isActive: true },
        professional: { tenantId, isActive: true },
      },
      select: { professionalId: true, locationId: true, isPrimary: true },
    }) as Promise<LocationLinkRow[]>,
  ]);
  if (rows.length < 2) return { locations: [], links: [] };
  const locations = rows
    .map((row) => ({
      ...row,
      professionalIds: [...new Set(allLinks.filter((l) => l.locationId === row.id).map((l) => l.professionalId))],
    }))
    .filter((l) => l.professionalIds.length > 0);
  if (locations.length < 2) return { locations: [], links: [] };
  const offered = new Set(locations.map((l) => l.id));
  return { locations, links: allLinks.filter((l) => offered.has(l.locationId)) };
}

/**
 * A professional's locations among `locations`, and their main one (their
 * primary when it is offered, else the first). Empty when they work at none.
 */
export function professionalLocationsOf(
  professionalId: string,
  locations: Array<{ id: string }>,
  links: LocationLinkRow[],
): { locationIds: string[]; primaryLocationId: string | null } {
  const offered = new Set(locations.map((l) => l.id));
  const mine = links.filter((l) => l.professionalId === professionalId && offered.has(l.locationId));
  // In the order the client sees the locations.
  const locationIds = locations.map((l) => l.id).filter((id) => mine.some((l) => l.locationId === id));
  const primaryLocationId = mine.find((l) => l.isPrimary)?.locationId ?? locationIds[0] ?? null;
  return { locationIds, primaryLocationId };
}

/** "Calle Mayor 1, 28013 Madrid" -- the parts that exist. */
export function formatLocationAddress(
  l: Pick<ClientLocationRow, "street" | "city" | "state" | "postalCode">,
): string {
  const cityLine = [l.postalCode, l.city].filter((p) => p && String(p).trim()).join(" ");
  const state = l.state && l.state !== l.city ? l.state : null;
  return [l.street, cityLine, state].filter((p) => p && String(p).trim()).join(", ");
}

/** Where an appointment is, for the notices to the client. */
export interface BookingPlace {
  name: string;
  /** Empty when the location has no address recorded. */
  address: string;
  phone: string | null;
}

/**
 * The location an appointment is at, to name it and give its address in the
 * emails -- only when the salon has two or more open locations. With one,
 * the notices stay as they were (the salon's own name and address). Null
 * when the appointment has no location or it is closed.
 */
export async function bookingPlace(
  db: Pick<ClientLocationsDb, "location">,
  tenantId: string,
  locationId: string | null | undefined,
): Promise<BookingPlace | null> {
  if (!locationId || !tenantId) return null;
  const open: ClientLocationRow[] = await db.location.findMany({
    where: { tenantId, isActive: true },
    select: CLIENT_LOCATION_SELECT,
  });
  if (open.length < 2) return null;
  const here = open.find((l) => l.id === locationId);
  if (!here) return null;
  return { name: here.name, address: formatLocationAddress(here), phone: here.phone ?? null };
}
