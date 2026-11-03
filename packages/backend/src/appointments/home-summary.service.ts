import { Injectable } from "@nestjs/common";
import { AppointmentStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { AppointmentsService } from "./appointments.service";
import { AnalyticsService } from "../analytics/analytics.service";
import { AnalyticsFlagsService } from "../analytics/analytics-flags.service";
import { appointmentLocationWhere, requestedLocationScope, type LocationScope } from "../analytics/analytics-location";
import type { Occupancy } from "../analytics/analytics-metrics";

/**
 * GET /appointments/home: the panel's Inicio lists, worked out by the server.
 *
 * The page used to ask for every "pending" appointment of a year back and a
 * year ahead (oldest first) and keep the first five: a salon with forty saw
 * five from ten months ago, its counters never passed 5, and "today's
 * schedule" held only the pending ones -- of any day to come. The pending
 * payments were the salon's whole history, each with its payments.
 *
 * Here, in the salon's own day and clock:
 * - `today`: today's appointments still to be served (pending, confirmed,
 *   in progress), by time, with the salon's "now" for "what is left";
 * - `professionals`: the active professionals, for "Agenda de hoy por
 *   profesional" (D30) -- those with nothing booked today too;
 * - `occupancy`: today's occupancy, Analítica's definition (owner and admins);
 * - `pendingConfirmations`: pending appointments from today on, soonest
 *   first, five rows and the true total;
 * - `pendingPayments`: visits up to today still owed (the rule of
 *   GET /appointments/pending-payment), latest first, five rows, the true
 *   total and what is owed in all.
 *
 * A staff member sees only their own appointments (findAll and
 * findPendingPayment scope them; the count here does the same), only
 * themselves among the professionals, and no occupancy (a salon figure).
 *
 * `locationId` (Empresa, D24): owner and admins get one location's lists,
 * with Analítica's rule of what belongs to a location (analytics-location.ts)
 * and its checks (400 malformed, 403 plan, 404 not this salon's). Staff
 * already see only their own, and the filter is ignored for them.
 */

/** Rows each Inicio list shows. */
export const HOME_LIST_SIZE = 5;

/** The statuses of an appointment still to be served today. */
export const ACTIVE_TODAY: readonly string[] = [
  AppointmentStatus.pending,
  AppointmentStatus.confirmed,
  AppointmentStatus.in_progress,
];

const DEFAULT_TZ = "Europe/Madrid";

export interface HomePerson {
  id: string;
  firstName: string;
  lastName: string;
}

export interface HomeAppointmentRow {
  id: string;
  scheduledDate: string;
  scheduledTime: string;
  status: string;
  paymentStatus?: string;
  amountDue?: number;
  client: HomePerson | null;
  professional: HomePerson | null;
  service: { id: string; name: string } | null;
}

export interface HomeSummary {
  /** The salon's calendar day, "YYYY-MM-DD". */
  today: string;
  /** The salon's clock, "HH:mm". */
  now: string;
  /** The location the lists are cut to; null for the whole salon. */
  location: { id: string; name: string } | null;
  todayAppointments: HomeAppointmentRow[];
  /** Active professionals (of the location; a staff member: themselves), by name. */
  professionals: HomePerson[];
  /** Today's occupancy; null for staff. */
  occupancy: Occupancy | null;
  pendingConfirmations: { total: number; items: HomeAppointmentRow[] };
  /** `totalDue` in cents (money, tax included), like `amountDue`. */
  pendingPayments: { total: number; totalDue: number; items: HomeAppointmentRow[] };
}

/** The salon's day and "HH:mm" at `now`. */
export function salonNow(timeZone: string, now: Date = new Date()): { day: string; time: string } {
  const read = (tz: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
  };
  try {
    return read(timeZone || DEFAULT_TZ);
  } catch {
    // An unknown zone name in the salon's settings.
    return read(DEFAULT_TZ);
  }
}

/**
 * Whether an appointment belongs to the scope's location: booked there, or
 * booked with no location by one of its professionals. The in-memory twin of
 * appointmentLocationWhere, for rows already read.
 */
export function inLocation(
  apt: { locationId?: string | null; professionalId?: string | null },
  scope: LocationScope | undefined,
): boolean {
  if (!scope) return true;
  if (apt.locationId) return apt.locationId === scope.locationId;
  return !!apt.professionalId && scope.professionalIds.includes(apt.professionalId);
}

/** "HH:mm" with a leading zero ("9:30" sorts after "10:00" otherwise). */
function timeKey(time: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "99:99";
}

function dayOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function person(p: any): HomePerson | null {
  return p ? { id: p.id, firstName: p.firstName ?? "", lastName: p.lastName ?? "" } : null;
}

/** Just what the page shows of an appointment. */
export function homeRow(apt: any): HomeAppointmentRow {
  return {
    id: apt.id,
    scheduledDate: dayOf(apt.scheduledDate),
    scheduledTime: apt.scheduledTime,
    status: apt.status,
    ...(apt.paymentStatus !== undefined ? { paymentStatus: apt.paymentStatus } : {}),
    ...(typeof apt.amountDue === "number" ? { amountDue: apt.amountDue } : {}),
    client: person(apt.client),
    professional: person(apt.professional),
    service: apt.service ? { id: apt.service.id, name: apt.service.name } : null,
  };
}

const byDateAndTime = (a: HomeAppointmentRow, b: HomeAppointmentRow) =>
  a.scheduledDate.localeCompare(b.scheduledDate) || timeKey(a.scheduledTime).localeCompare(timeKey(b.scheduledTime));

const byName = (a: HomePerson, b: HomePerson) =>
  `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`, "es");

@Injectable()
export class HomeSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appointments: AppointmentsService,
    private readonly analytics: AnalyticsService,
    private readonly analyticsFlags: AnalyticsFlagsService,
  ) {}

  async getHome(
    user: { id: string; tenantId: string; role: string },
    options: { locationId?: string } = {},
    now: Date = new Date(),
  ): Promise<HomeSummary> {
    const staff = user.role === "staff";
    const [tenant, scope] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { timezone: true } }),
      staff
        ? Promise.resolve(undefined)
        : requestedLocationScope(
            user.tenantId,
            options.locationId,
            {
              hasLocationFilter: (t) => this.analyticsFlags.hasLocationFilter(t),
              locationScope: (t, id) => this.analytics.locationScope(t, id),
            },
            "Ver Inicio por local está disponible en el plan Empresa.",
          ),
    ]);
    const { day, time } = salonNow(tenant?.timezone || DEFAULT_TZ, now);
    const empty: HomeSummary = {
      today: day,
      now: time,
      location: null,
      todayAppointments: [],
      professionals: [],
      occupancy: null,
      pendingConfirmations: { total: 0, items: [] },
      pendingPayments: { total: 0, totalDue: 0, items: [] },
    };

    // Staff: their own appointments. An account with no professional sees
    // none (as findAll and findPendingPayment answer it).
    let professionalId: string | undefined;
    if (staff) {
      const professional = await this.prisma.professional.findFirst({
        where: { userId: user.id, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!professional) return empty;
      professionalId = professional.id;
    }

    const dayStart = new Date(`${day}T00:00:00.000Z`);
    const dayEnd = new Date(`${day}T23:59:59.999Z`);
    const pendingWhere = {
      tenantId: user.tenantId,
      isTest: false,
      status: AppointmentStatus.pending,
      scheduledDate: { gte: dayStart },
      ...(professionalId ? { professionalId } : {}),
      ...appointmentLocationWhere(scope),
    };
    const refSelect = { select: { id: true, firstName: true, lastName: true } };

    const [todays, pendingTotal, pendingFirst, owed, team, occupancy] = await Promise.all([
      this.appointments.findAll(user, { startDate: dayStart, endDate: dayEnd }),
      this.prisma.appointment.count({ where: pendingWhere }),
      this.prisma.appointment.findMany({
        where: pendingWhere,
        select: {
          id: true,
          scheduledDate: true,
          scheduledTime: true,
          status: true,
          paymentStatus: true,
          client: refSelect,
          professional: refSelect,
          service: { select: { id: true, name: true } },
        },
        orderBy: [{ scheduledDate: "asc" }, { scheduledTime: "asc" }],
        take: HOME_LIST_SIZE,
      }),
      // The visits up to the end of the salon's today, not the UTC one.
      this.appointments.findPendingPayment(user, { dateTo: dayEnd.toISOString() }),
      this.prisma.professional.findMany({
        where: {
          tenantId: user.tenantId,
          ...(professionalId
            ? { id: professionalId }
            : { isActive: true, ...(scope ? { id: { in: scope.professionalIds } } : {}) }),
        },
        select: { id: true, firstName: true, lastName: true },
      }),
      staff ? Promise.resolve(null) : this.analytics.getTodayOccupancy(user.tenantId, scope),
    ]);

    // The wizard's test booking stays in the agenda but out of Inicio (D27).
    const todayAppointments = (todays as any[])
      .filter((a) => !a.isTest && ACTIVE_TODAY.includes(a.status) && inLocation(a, scope))
      .map(homeRow)
      .sort(byDateAndTime);

    const owedRows = (owed as any[]).filter((a) => inLocation(a, scope)).map(homeRow);
    const latestOwed = [...owedRows].sort(byDateAndTime).reverse().slice(0, HOME_LIST_SIZE);

    return {
      today: day,
      now: time,
      location: scope ? { id: scope.locationId, name: scope.name } : null,
      todayAppointments,
      professionals: (team as any[]).map((p) => person(p) as HomePerson).sort(byName),
      occupancy,
      pendingConfirmations: {
        total: pendingTotal,
        items: (pendingFirst as any[]).map(homeRow).sort(byDateAndTime),
      },
      pendingPayments: {
        total: owedRows.length,
        totalDue: owedRows.reduce((sum, r) => sum + (r.amountDue ?? 0), 0),
        items: latestOwed,
      },
    };
  }
}
