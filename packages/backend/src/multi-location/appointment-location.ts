/**
 * Which of the salon's locations a new appointment belongs to.
 *
 * `appointments.locationId` existed for the consolidated report but no
 * booking path wrote it, so every appointment was attributed afterwards by
 * where its professional works today -- and moved when the professional
 * did. No booking (online, staff, receptionist, import, onboarding) carries
 * a location of its own, so the professional's location is the only source:
 * their only active location, or their primary one when they work at
 * several (the same rule as the report's fallback, see homeLocations).
 * Null when that is ambiguous or the salon has no locations; the report
 * still attributes those rows itself.
 */

import { homeLocations, LocationLink } from "./consolidated-report";

/** The part of PrismaService this needs; specs pass a plain mock. */
export interface LocationLinkReader {
  professionalLocation: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<LocationLink[]>;
  };
}

/** The location of one professional's new appointment, or null. */
export async function appointmentLocationId(
  prisma: LocationLinkReader,
  tenantId: string,
  professionalId: string,
): Promise<string | null> {
  const links = await prisma.professionalLocation.findMany({
    where: { professionalId, location: { tenantId, isActive: true } },
    select: { professionalId: true, locationId: true, isPrimary: true },
  });
  return homeLocations(links, new Set(links.map((l) => l.locationId))).get(professionalId) ?? null;
}

/** Every professional's appointment location in the salon, for bulk inserts (import). */
export async function appointmentLocations(
  prisma: LocationLinkReader,
  tenantId: string,
): Promise<Map<string, string>> {
  const links = await prisma.professionalLocation.findMany({
    where: { location: { tenantId, isActive: true } },
    select: { professionalId: true, locationId: true, isPrimary: true },
  });
  return homeLocations(links, new Set(links.map((l) => l.locationId)));
}
