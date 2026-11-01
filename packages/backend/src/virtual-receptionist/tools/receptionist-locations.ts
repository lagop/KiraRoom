import type { SalonToolContext } from './salon-tools';
import type { Resolved } from './resolve-ids';
import {
  clientLocations,
  formatLocationAddress,
  professionalLocationsOf,
  type ClientLocation,
  type LocationLinkRow,
} from '../../multi-location/client-locations';

/**
 * Which of the salon's locations a chat booking is for (multi-local).
 *
 * A salon with two or more locations to book at (client-locations.ts) has
 * professionals who work at one or several of them, and availability and
 * booking take the location (professional-locations.ts). The receptionist
 * gets it, in this order, from:
 *
 *  1. the `locationId` the model passes -- an id, or a location's name or
 *     slug, as with services and professionals (resolve-ids.ts);
 *  2. the client's own message, when it names exactly one location
 *     ("en el de Chamberí");
 *  3. the professional, when they work at only one;
 *
 * and otherwise asks: the tool answers `location_required` with the options,
 * and the model asks the client. A named professional who does not work at
 * the location is refused with who does.
 *
 * A salon with one location is untouched: any locationId the model sends is
 * dropped, and nothing is asked.
 */

export interface SalonPlaces {
  locations: ClientLocation[];
  links: LocationLinkRow[];
}

const NONE: SalonPlaces = { locations: [], links: [] };

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The salon's locations to book at; none for a salon with one, or when they cannot be read. */
export async function salonPlaces(ctx: SalonToolContext): Promise<SalonPlaces> {
  const db = ctx.prisma as any;
  if (!db?.location?.findMany || !db?.professionalLocation?.findMany) return NONE;
  try {
    return await clientLocations(db, ctx.tenantId);
  } catch {
    // Booking as before (no location) beats a receptionist that cannot book.
    return NONE;
  }
}

/** A location as the model sees it. */
export function locationOption(l: ClientLocation): { id: string; name: string; address: string | null } {
  return { id: l.id, name: l.name, address: formatLocationAddress(l) || null };
}

/** The one location `value` names: its id, slug or name, or the only one whose name or address contains it. */
export function pickLocation(value: string, locations: ClientLocation[]): ClientLocation | undefined {
  const raw = value.trim().toLowerCase();
  const byKey = locations.find((l) => l.id.toLowerCase() === raw || l.slug.toLowerCase() === raw);
  if (byKey) return byKey;
  const wanted = normalize(value);
  if (!wanted) return undefined;
  const exact = locations.filter((l) => normalize(l.name) === wanted);
  if (exact.length === 1) return exact[0];
  const partial = locations.filter(
    (l) =>
      normalize(l.name).includes(wanted) ||
      wanted.includes(normalize(l.name)) ||
      normalize(formatLocationAddress(l)).includes(wanted),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

/**
 * The locations a client's message names, by their name as whole words
 * ("quiero ir al de Chamberí" names "Chamberí"). Only names: a street or a
 * city in a message is too often about something else.
 */
export function locationsMentioned(message: string, locations: ClientLocation[]): ClientLocation[] {
  const text = ` ${normalize(message)} `;
  if (!text.trim()) return [];
  return locations.filter((l) => {
    const name = normalize(l.name);
    const slug = normalize(l.slug);
    return (name && text.includes(` ${name} `)) || (slug && text.includes(` ${slug} `));
  });
}

/**
 * Sets `args.locationId` to the location of this availability check or
 * booking, or answers what the model must do instead (ask the client, pick
 * another professional). Expects `professionalId` already resolved to an id.
 */
export async function resolveLocation(
  ctx: SalonToolContext,
  args: Record<string, unknown>,
  places?: SalonPlaces,
): Promise<Resolved> {
  const { locations, links } = places ?? (await salonPlaces(ctx));
  if (locations.length === 0) {
    // One location (or none): as before, whatever the model sent.
    const { locationId: _ignored, ...rest } = args;
    return { ok: true, args: rest };
  }

  const options = locations.map(locationOption);
  const professionalId = typeof args.professionalId === 'string' && args.professionalId ? args.professionalId : undefined;
  const theirs = professionalId ? professionalLocationsOf(professionalId, locations, links) : null;

  let location: ClientLocation | undefined;
  if (typeof args.locationId === 'string' && args.locationId.trim()) {
    location = pickLocation(args.locationId, locations);
    if (!location) {
      return {
        ok: false,
        error: {
          error: 'location_not_found',
          message: 'Use one of these location ids (or their exact names) and call the tool again.',
          locations: options,
        },
      };
    }
  } else {
    const mentioned = locationsMentioned(ctx.conversation?.lastUserMessage ?? '', locations);
    if (mentioned.length === 1) {
      location = mentioned[0];
    } else if (theirs && theirs.locationIds.length === 1) {
      location = locations.find((l) => l.id === theirs.locationIds[0]);
    } else if (theirs && theirs.locationIds.length === 0) {
      // A professional assigned to no location: booked as before, at no
      // location in particular (the server allows it without a locationId).
      const { locationId: _none, ...rest } = args;
      return { ok: true, args: rest };
    } else {
      const among = theirs ? options.filter((o) => theirs.locationIds.includes(o.id)) : options;
      return {
        ok: false,
        error: {
          error: 'location_required',
          message: theirs
            ? 'This professional works at several of the salon\'s locations. Ask the client which one, then call the tool again with locationId.'
            : 'The salon has several locations. Ask the client which one they want (unless they already said), then call the tool again with locationId.',
          locations: among,
        },
      };
    }
  }

  if (theirs && !theirs.locationIds.includes(location!.id)) {
    const here = locations.find((l) => l.id === location!.id)!;
    const team = await (ctx.prisma as any).professional.findMany({
      where: { tenantId: ctx.tenantId, isActive: true, id: { in: here.professionalIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    return {
      ok: false,
      error: {
        error: 'professional_not_at_location',
        message:
          'This professional does not work at that location. Tell the client, and offer the professionals ' +
          'who work there, whoever is free there, or the locations this professional works at.',
        professionals: team.map((p: any) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`.trim() })),
        professionalLocations: options.filter((o) => theirs.locationIds.includes(o.id)),
      },
    };
  }

  return { ok: true, args: { ...args, locationId: location!.id } };
}

/** The location of a booking, for the summary the client confirms: "Centro (Calle Mayor 1, 28013 Madrid)". */
export async function locationLabel(ctx: SalonToolContext, locationId?: string): Promise<string | null> {
  if (!locationId) return null;
  const { locations } = await salonPlaces(ctx);
  const l = locations.find((x) => x.id === locationId);
  if (!l) return null;
  const address = formatLocationAddress(l);
  return address ? `${l.name} (${address})` : l.name;
}
