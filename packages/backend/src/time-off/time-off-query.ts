import { TimeOffBlock, dateOfDay } from "./time-off-rules";

/** Any client with the timeOff delegate: the app's, a transaction's, a spec's. */
export type TimeOffReader = { timeOff: { findMany: (args: any) => Promise<any[]> } };

export const TIME_OFF_SELECT = {
  id: true,
  professionalId: true,
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
 */
export async function timeOffBetween(
  prisma: TimeOffReader,
  tenantId: string,
  from: string,
  to: string = from,
): Promise<TimeOffBlock[]> {
  const fromDate = dateOfDay(from);
  const toDate = dateOfDay(to);
  if (!fromDate || !toDate) return [];
  return prisma.timeOff.findMany({
    where: { tenantId, status: "approved", startDate: { lte: toDate }, endDate: { gte: fromDate } },
    select: TIME_OFF_SELECT,
  });
}
