import { TimeOffBlock, dateOfDay } from "./time-off-rules";

/** Any client with the timeOff delegate: the app's, a transaction's, a spec's. */
export type TimeOffReader = {
  timeOff: { findMany: (args: any) => Promise<any[]> };
  /** Who works at each location: a location's closure stops them (localizeClosures). */
  professionalLocation?: { findMany: (args: any) => Promise<Array<{ professionalId: string; locationId: string }>> };
};

export const TIME_OFF_SELECT = {
  id: true,
  professionalId: true,
  locationId: true,
  kind: true,
  startDate: true,
  endDate: true,
  startTime: true,
  endTime: true,
  note: true,
  status: true,
} as const;

/**
 * The salon's approved time off and closures that touch the days `from` to
 * `to` ("YYYY-MM-DD", inclusive), everyone's: the callers pick what applies
 * with dayBlocks. A request still pending or rejected blocks nothing. Filtered by tenant here as well as by the client extension,
 * like every other query on a booking path.
 *
 * Closures of one location (multi-local, TimeOff.locationId): with
 * `opts.locationId`, only that location's and the general ones -- the
 * question is about that location. Without one, a location's closure stops
 * the professionals who work there (localizeClosures) instead of closing
 * every location.
 */
export async function timeOffBetween(
  prisma: TimeOffReader,
  tenantId: string,
  from: string,
  to: string = from,
  opts: { locationId?: string | null } = {},
): Promise<TimeOffBlock[]> {
  const fromDate = dateOfDay(from);
  const toDate = dateOfDay(to);
  if (!fromDate || !toDate) return [];
  const rows: TimeOffBlock[] = await prisma.timeOff.findMany({
    where: {
      tenantId,
      status: "approved",
      startDate: { lte: toDate },
      endDate: { gte: fromDate },
      ...(opts.locationId ? { OR: [{ locationId: null }, { locationId: opts.locationId }] } : {}),
    },
    select: TIME_OFF_SELECT,
  });
  if (opts.locationId) return rows;
  const places = [...new Set(rows.flatMap((r) => (r.professionalId === null && r.locationId ? [r.locationId] : [])))];
  // A client without the join table (a spec's): the closure stays salon-wide.
  if (places.length === 0 || !prisma.professionalLocation) return rows;
  const links = await prisma.professionalLocation.findMany({
    where: { locationId: { in: places }, location: { tenantId } },
    select: { professionalId: true, locationId: true },
  });
  return localizeClosures(rows, links);
}

/**
 * A location's closure, when the question is not about one location, as the
 * time off of each professional who works there: they cannot be booked
 * anywhere then (a conservative reading for a professional of several
 * locations), and the other locations stay open. Nobody working there:
 * nothing to block.
 */
export function localizeClosures(
  blocks: ReadonlyArray<TimeOffBlock>,
  links: ReadonlyArray<{ professionalId: string; locationId: string }>,
): TimeOffBlock[] {
  return blocks.flatMap((b) =>
    b.professionalId === null && b.locationId
      ? links.filter((l) => l.locationId === b.locationId).map((l) => ({ ...b, professionalId: l.professionalId }))
      : [b],
  );
}
