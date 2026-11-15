import {
  ShiftWindow,
  bookableWindows,
  clockOf,
  mergeWindows,
  minutesOf,
  salonWindowsFor,
  subtractWindows,
  workingWindowsFor,
} from '../../appointments/working-hours';
import { availableWindows, dayBlocks, salonClosedOn, type TimeOffBlock } from '../../time-off/time-off-rules';
import { timeOffBetween } from '../../time-off/time-off-query';
import {
  VISIT_ROW_ORDER,
  VISIT_ROW_SELECT,
  appointmentBusyBlocks,
  isLiveRow,
  minutesUntilFree,
  type VisitRow,
} from '../../appointments/visit-totals';
import { addDays } from '../../analytics/analytics-metrics';
import type { BriefingBusy, BriefingGap, BriefingProfessional } from '../briefing-gaps';

/**
 * The Copilot's free gaps ("huecos"), per professional (Copilot audit M6).
 *
 * `get_my_agenda` and `find_filling_opportunities` used to sort the whole
 * salon's appointments into one row and report the space between consecutive
 * ones: Lucía free all afternoon never showed, the lunch closure showed as a
 * gap, and so did this morning's hours that had already gone. They now read
 * the gaps the way the daily briefing does (../briefing-gaps.ts, the copilot's
 * "Inicio" card): each professional's bookable hours (their shifts within the
 * salon's hours, minus approved time off and the salon's closures) minus
 * their own non-cancelled appointments and the cleanup after them, from now
 * on.
 *
 * `freeGapsOfDay` is briefingGaps with the minimum gap as a parameter (the
 * briefing's is fixed at 30 minutes and the tool lets the salon ask for 15).
 * Keep the two in step.
 */

/** Appointments that hold the professional's time: everything but cancelled and no-show. */
export const BUSY_STATUSES = ['pending', 'confirmed', 'in_progress', 'completed'] as const;

/**
 * Who an appointment keeps busy, and when, for the gaps. A visit done by its
 * own professional reads as before: from its time until she is free again
 * (its length, 30 min when it has none, plus the cleanup). A visit with a
 * service done by a colleague (the rinse after the colour) keeps each one
 * busy during her own services, as the agenda reads it
 * (appointmentBusyBlocks): the colleague used to show as free then.
 */
export function visitBusy(
  apt: {
    professionalId: string | null;
    scheduledTime: string;
    duration?: number | null;
    service?: { bufferTime?: number | null } | null;
    services?: VisitRow[] | null;
  },
  timeZone: string,
  day: string,
): BriefingBusy[] {
  const live = (apt.services ?? []).filter(isLiveRow);
  const shared = live.some((r) => r.professionalId && r.professionalId !== apt.professionalId);
  if (!shared) {
    return [{ professionalId: apt.professionalId, start: apt.scheduledTime, minutes: minutesUntilFree(apt as any, 30) }];
  }
  return appointmentBusyBlocks(
    { ...apt, professionalId: apt.professionalId ?? '', duration: Number(apt.duration) || 0 },
    timeZone,
    day,
  )
    .filter((b) => b.professionalId && b.endMinutes > b.startMinutes)
    .map((b) => ({
      professionalId: b.professionalId,
      start: clockOf(Math.max(0, b.startMinutes)),
      minutes: b.endMinutes - Math.max(0, b.startMinutes),
    }));
}

/**
 * The where clause for the appointments that keep `ids` busy: their own, and
 * a colleague's visit where one of them does a service.
 */
export function busyAppointmentsOf(ids: string[]) {
  return {
    OR: [{ professionalId: { in: ids } }, { services: { some: { professionalId: { in: ids } } } }],
  };
}

/** What visitBusy reads of an appointment. */
export const VISIT_BUSY_SELECT = {
  professionalId: true,
  scheduledTime: true,
  duration: true,
  service: { select: { bufferTime: true } },
  services: { select: VISIT_ROW_SELECT, orderBy: VISIT_ROW_ORDER as any },
} as const;

export interface DayGap extends BriefingGap {
  /** "YYYY-MM-DD" */
  date: string;
}

export function freeGapsOfDay(input: {
  /** "YYYY-MM-DD" */
  day: string;
  /** Minutes since midnight in the salon's clock before which the day is gone (0 for a future day). */
  nowMinutes: number;
  openingHours: unknown;
  professionals: ReadonlyArray<BriefingProfessional>;
  busy: ReadonlyArray<BriefingBusy>;
  blocks?: ReadonlyArray<TimeOffBlock>;
  minGapMinutes: number;
}): DayGap[] {
  const date = new Date(`${input.day}T00:00:00.000Z`);
  const blocks = input.blocks ?? [];
  if (salonClosedOn(blocks, input.day)) return [];
  const salon = salonWindowsFor(input.openingHours, date);
  const gaps: DayGap[] = [];

  for (const prof of input.professionals) {
    const busy: ShiftWindow[] = input.busy
      .filter((b) => b.professionalId === prof.id)
      .map((b) => {
        const start = minutesOf(b.start) ?? 0;
        return { startMinutes: start, endMinutes: start + Math.max(0, b.minutes) };
      });

    const scheduled = bookableWindows(workingWindowsFor(prof.workingHours, date), salon);
    const blocked = dayBlocks(blocks, input.day, prof.id);

    let free: ShiftWindow[];
    if (scheduled === undefined) {
      // No hours known anywhere: only between their own appointments, as the
      // briefing does, minus any time off that day.
      if (blocked.allDay) continue;
      const merged = mergeWindows(busy);
      free = [];
      for (let i = 0; i + 1 < merged.length; i++) {
        free.push({ startMinutes: merged[i].endMinutes, endMinutes: merged[i + 1].startMinutes });
      }
      if (blocked.windows.length) free = subtractWindows(free, blocked.windows);
    } else {
      free = subtractWindows(availableWindows(scheduled, blocked) ?? [], busy);
    }

    for (const w of free) {
      const start = Math.max(w.startMinutes, input.nowMinutes);
      const minutes = w.endMinutes - start;
      if (minutes < input.minGapMinutes) continue;
      gaps.push({
        date: input.day,
        start: clockOf(start),
        end: clockOf(w.endMinutes),
        minutes,
        professionalId: prof.id,
        professionalFirstName: prof.firstName,
      });
    }
  }

  return gaps.sort(
    (a, b) => a.start.localeCompare(b.start) || a.professionalFirstName.localeCompare(b.professionalFirstName),
  );
}

/**
 * The gaps of the days `fromDay`..`toDay` (inclusive), read from the
 * database: the salon's active professionals (only `professionalIds` when
 * given; only those who work at `locationId` when given), their schedules,
 * the approved time off and closures, and their appointments.
 */
export async function loadProfessionalGaps(
  prisma: any,
  q: {
    tenantId: string;
    fromDay: string;
    toDay: string;
    /** The salon's today and its clock now: earlier days and minutes are gone. */
    todayDay: string;
    nowMinutes: number;
    openingHours: unknown;
    /** The salon's time zone, to place a shared visit's services. */
    timeZone: string;
    professionalIds?: string[] | null;
    locationId?: string | null;
    minGapMinutes: number;
  },
): Promise<{ gaps: DayGap[]; professionals: BriefingProfessional[] }> {
  const professionals: BriefingProfessional[] = await prisma.professional.findMany({
    where: {
      tenantId: q.tenantId,
      isActive: true,
      ...(q.professionalIds ? { id: { in: q.professionalIds } } : {}),
      ...(q.locationId ? { locations: { some: { locationId: q.locationId } } } : {}),
    },
    select: { id: true, firstName: true, workingHours: true },
  });
  if (professionals.length === 0) return { gaps: [], professionals };

  const from = new Date(`${q.fromDay}T00:00:00.000Z`);
  const to = new Date(`${addDays(q.toDay, 1)}T00:00:00.000Z`);
  // Every appointment of theirs holds them, whatever the location, and so
  // does a colleague's visit where they do a service.
  const appointments: Array<{
    professionalId: string | null;
    scheduledDate: Date;
    scheduledTime: string;
  }> = await prisma.appointment.findMany({
    where: {
      tenantId: q.tenantId,
      isTest: false,
      scheduledDate: { gte: from, lt: to },
      status: { in: [...BUSY_STATUSES] },
      ...busyAppointmentsOf(professionals.map((p) => p.id)),
    },
    select: { ...VISIT_BUSY_SELECT, scheduledDate: true },
  });
  const blocks = await timeOffBetween(prisma, q.tenantId, q.fromDay, q.toDay, { locationId: q.locationId ?? null });

  const busyByDay = new Map<string, BriefingBusy[]>();
  for (const a of appointments) {
    const day = a.scheduledDate.toISOString().slice(0, 10);
    const list = busyByDay.get(day) ?? [];
    // As the briefing: free again after the appointment (30 min when it
    // has no length) and its cleanup time; each professional of a shared
    // visit during her own services.
    list.push(...visitBusy(a as any, q.timeZone, day));
    busyByDay.set(day, list);
  }

  const gaps: DayGap[] = [];
  for (let day = q.fromDay; day <= q.toDay; day = addDays(day, 1)) {
    if (day < q.todayDay) continue; // gone
    gaps.push(
      ...freeGapsOfDay({
        day,
        nowMinutes: day === q.todayDay ? q.nowMinutes : 0,
        openingHours: q.openingHours,
        professionals,
        busy: busyByDay.get(day) ?? [],
        blocks,
        minGapMinutes: q.minGapMinutes,
      }),
    );
  }
  return { gaps, professionals };
}

/* -------------------------------------------------------------------------- */
/*  Wait-list suggestions per gap                                            */
/* -------------------------------------------------------------------------- */

export interface WaitListCandidate {
  id: string;
  clientId: string;
  firstName: string;
  serviceId: string;
  serviceName: string | null;
  /** Minutes the service takes, when known. */
  serviceMinutes: number | null;
  /** The professional she asked for, if any. */
  professionalId: string | null;
  earliestDay: string | null;
  latestDay: string | null;
  createdAt: Date;
  /** Professionals who perform the service; empty = anyone (as offersService). */
  performedBy: string[];
}

export interface GapSuggestion {
  clientId: string;
  firstName: string;
  service: string | null;
  /** True when she asked for this gap's professional. */
  askedForThisProfessional: boolean;
}

/**
 * Who on the wait list could fill each gap: her dates include the gap's day,
 * she asked for no professional or for this one, the professional performs
 * the service, and the service fits in the gap. Those who asked for this
 * professional first, then those suggested fewest times so far (so the gaps
 * do not all offer the same five), then the longest waiting.
 */
export function suggestForGaps<G extends { date: string; minutes: number; professionalId: string }>(
  gaps: ReadonlyArray<G>,
  candidates: ReadonlyArray<WaitListCandidate>,
  topN: number,
): Array<G & { suggestions: GapSuggestion[] }> {
  const used = new Map<string, number>();
  return gaps.map((gap) => {
    const fitting = candidates.filter(
      (c) =>
        (c.earliestDay === null || c.earliestDay <= gap.date) &&
        (c.latestDay === null || c.latestDay >= gap.date) &&
        (c.professionalId === null || c.professionalId === gap.professionalId) &&
        (c.performedBy.length === 0 || c.performedBy.includes(gap.professionalId)) &&
        (c.serviceMinutes === null || c.serviceMinutes <= gap.minutes),
    );
    // One entry per client in a gap (she may wait for two services).
    const seen = new Set<string>();
    const ranked = fitting
      .slice()
      .sort(
        (a, b) =>
          Number(b.professionalId === gap.professionalId) - Number(a.professionalId === gap.professionalId) ||
          (used.get(a.clientId) ?? 0) - (used.get(b.clientId) ?? 0) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .filter((c) => (seen.has(c.clientId) ? false : (seen.add(c.clientId), true)))
      .slice(0, topN);
    for (const c of ranked) used.set(c.clientId, (used.get(c.clientId) ?? 0) + 1);
    return {
      ...gap,
      suggestions: ranked.map((c) => ({
        clientId: c.clientId,
        firstName: c.firstName,
        service: c.serviceName,
        askedForThisProfessional: c.professionalId === gap.professionalId,
      })),
    };
  });
}

/** At most this many wait-list entries are read for one question. */
export const WAIT_LIST_READ_LIMIT = 200;

/**
 * The wait-list entries still waiting whose dates touch `fromDay`..`toDay`,
 * of clients who are not blocked or inactive, with their service's name,
 * length and who performs it.
 */
export async function loadWaitListCandidates(
  prisma: any,
  q: { tenantId: string; fromDay: string; toDay: string },
): Promise<WaitListCandidate[]> {
  const from = new Date(`${q.fromDay}T00:00:00.000Z`);
  const to = new Date(`${q.toDay}T00:00:00.000Z`);
  const rows: Array<{
    id: string;
    clientId: string;
    serviceId: string;
    professionalId: string | null;
    earliestDate: Date | null;
    latestDate: Date | null;
    createdAt: Date;
    client: { id: string; firstName: string; status?: string } | null;
  }> = await prisma.waitList.findMany({
    where: {
      tenantId: q.tenantId,
      // Told about an earlier slot is still waiting, as close_waitlist_slot reads it.
      status: { in: ['waiting', 'notified'] },
      // A blocked (or inactive) client is never offered a gap.
      client: { status: 'active' },
      AND: [
        { OR: [{ earliestDate: null }, { earliestDate: { lte: to } }] },
        { OR: [{ latestDate: null }, { latestDate: { gte: from } }] },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: WAIT_LIST_READ_LIMIT,
    select: {
      id: true,
      clientId: true,
      serviceId: true,
      professionalId: true,
      earliestDate: true,
      latestDate: true,
      createdAt: true,
      client: { select: { id: true, firstName: true, status: true } },
    },
  });
  // Belt and braces: a blocked client never reaches the model.
  const live = rows.filter((r) => r.client && (r.client.status === undefined || r.client.status === 'active'));
  if (live.length === 0) return [];

  const serviceIds = [...new Set(live.map((r) => r.serviceId))];
  const services: Array<{
    id: string;
    name: string;
    duration: number | null;
    professionals?: Array<{ professionalId: string; professional?: { isActive?: boolean } | null }>;
  }> = await prisma.service.findMany({
    where: { tenantId: q.tenantId, id: { in: serviceIds } },
    select: {
      id: true,
      name: true,
      duration: true,
      professionals: { select: { professionalId: true, professional: { select: { isActive: true } } } },
    },
  });
  const byId = new Map(services.map((s) => [s.id, s]));

  return live.map((r) => {
    const s = byId.get(r.serviceId);
    return {
      id: r.id,
      clientId: r.client!.id,
      firstName: r.client!.firstName,
      serviceId: r.serviceId,
      serviceName: s?.name ?? null,
      serviceMinutes: s && Number(s.duration) > 0 ? Number(s.duration) : null,
      professionalId: r.professionalId,
      earliestDay: r.earliestDate ? r.earliestDate.toISOString().slice(0, 10) : null,
      latestDay: r.latestDate ? r.latestDate.toISOString().slice(0, 10) : null,
      createdAt: r.createdAt,
      performedBy: (s?.professionals ?? [])
        .filter((p) => p.professional?.isActive !== false)
        .map((p) => p.professionalId),
    };
  });
}
