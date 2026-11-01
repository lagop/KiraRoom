import { BadRequestException, NotFoundException } from "@nestjs/common";

/**
 * Which of the salon's locations a professional works at.
 *
 * The join table (professional_locations, with an isPrimary flag) existed
 * from the start and the consolidated report read it, but nothing wrote it:
 * the team form had no field, so a professional could not be assigned to
 * any location, let alone several. Now the team form sends the list
 * (AdminProfessionalsService), and availability and booking for a location
 * consider only the professionals assigned to it.
 *
 * Schedules stay per professional, not per location: a professional's
 * working hours are theirs, they can be booked at any of their locations,
 * and the agenda's overlap check is per professional over every location
 * (getAvailableSlots, assertCanBook), so they are never booked twice at the
 * same time in two places.
 *
 * The primary location is the one the reports and an appointment without a
 * location of its own fall back to (appointment-location.ts, homeLocations).
 */

/** The part of a Prisma client (or transaction) these helpers use. */
export interface LocationsDb {
  location: { findMany(args: any): Promise<Array<{ id: string; isActive?: boolean }>>; findFirst(args: any): Promise<any> };
  professionalLocation: {
    findMany(args: any): Promise<Array<{ professionalId: string; locationId: string; isPrimary: boolean }>>;
    deleteMany(args: any): Promise<unknown>;
    createMany(args: any): Promise<unknown>;
    updateMany(args: any): Promise<unknown>;
  };
}

export const LOCATION_NOT_FOUND = "Ese local no existe o está cerrado.";

/**
 * Replaces the professional's locations with `locationIds` (this salon's
 * active locations only), in one go: links not in the list are removed, new
 * ones added, and exactly one is primary -- `primaryLocationId` when given
 * and in the list, else the one that was primary if it stays, else the
 * first. An empty list removes every link. `db` should be a transaction.
 */
export async function setProfessionalLocations(
  db: LocationsDb,
  tenantId: string,
  professionalId: string,
  locationIds: string[],
  primaryLocationId?: string | null,
): Promise<Array<{ locationId: string; isPrimary: boolean }>> {
  const wanted = [...new Set(locationIds)];
  if (primaryLocationId && !wanted.includes(primaryLocationId)) {
    throw new BadRequestException("El local principal tiene que estar entre los locales del profesional.");
  }
  if (wanted.length > 0) {
    const found = await db.location.findMany({
      where: { tenantId, isActive: true, id: { in: wanted } },
      select: { id: true },
    });
    if (found.length !== wanted.length) {
      throw new BadRequestException("Alguno de los locales elegidos no existe o está cerrado. Recarga la página.");
    }
  }

  const current = await db.professionalLocation.findMany({
    where: { professionalId },
    select: { professionalId: true, locationId: true, isPrimary: true },
  });
  const primary =
    wanted.length === 0
      ? null
      : primaryLocationId ??
        current.find((l) => l.isPrimary && wanted.includes(l.locationId))?.locationId ??
        wanted[0];

  // Every link of the professional not in the list goes, whatever salon it
  // points at (an old row of another salon's location cannot be one of theirs).
  await db.professionalLocation.deleteMany({
    where: { professionalId, locationId: { notIn: wanted } },
  });
  const have = new Set(current.map((l) => l.locationId));
  const added = wanted.filter((id) => !have.has(id));
  if (added.length > 0) {
    await db.professionalLocation.createMany({
      data: added.map((locationId) => ({ professionalId, locationId, isPrimary: false })),
      skipDuplicates: true,
    });
  }
  if (primary) {
    await db.professionalLocation.updateMany({
      where: { professionalId, locationId: { not: primary }, isPrimary: true },
      data: { isPrimary: false },
    });
    await db.professionalLocation.updateMany({
      where: { professionalId, locationId: primary },
      data: { isPrimary: true },
    });
  }
  return wanted.map((locationId) => ({ locationId, isPrimary: locationId === primary }));
}

/** The part of a Prisma client professionalsAt reads. */
export interface LocationReader {
  location: { findFirst(args: any): Promise<{ id: string } | null> };
  professionalLocation: { findMany(args: any): Promise<Array<{ professionalId: string }>> };
}

/**
 * The professionals assigned to one of the salon's locations. 404 when the
 * location is not this salon's or is closed: nothing can be booked there.
 */
export async function professionalsAt(
  db: LocationReader,
  tenantId: string,
  locationId: string,
): Promise<Set<string>> {
  const location = await db.location.findFirst({
    where: { id: locationId, tenantId, isActive: true },
    select: { id: true },
  });
  if (!location) throw new NotFoundException(LOCATION_NOT_FOUND);
  const links = await db.professionalLocation.findMany({
    where: { locationId },
    select: { professionalId: true },
  });
  return new Set(links.map((l) => l.professionalId));
}

/**
 * 400 unless every professional of a booking at `locationId` works there.
 * The booking pages only offer those (getAvailableSlots with the location);
 * a direct request could name anyone.
 */
export async function assertProfessionalsAt(
  db: LocationReader,
  tenantId: string,
  locationId: string,
  professionalIds: Array<string | null | undefined>,
): Promise<void> {
  const here = await professionalsAt(db, tenantId, locationId);
  const away = professionalIds.filter((id): id is string => !!id).find((id) => !here.has(id));
  if (away) {
    throw new BadRequestException("Ese profesional no trabaja en este local. Elige otro profesional o local.");
  }
}
