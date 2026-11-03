import { Injectable } from "@nestjs/common";
import { AppointmentStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { AppointmentsService, staffAgendaWhere } from "./appointments.service";

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
 * - `pendingConfirmations`: pending appointments from today on, soonest
 *   first, five rows and the true total;
 * - `pendingPayments`: visits up to today still owed (the rule of
 *   GET /appointments/pending-payment), latest first, five rows, the true
 *   total and what is owed in all.
 *
 * A staff member sees only their own agenda: their appointments and the
 * colleagues' visits where they do a service (findAll and
 * findPendingPayment scope them; the pending count and list here use the
 * same filter, staffAgendaWhere).
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

export interface HomeAppointmentRow {
  id: string;
  scheduledDate: string;
  scheduledTime: string;
  status: string;
  paymentStatus?: string;
  amountDue?: number;
  client: { id: string; firstName: string; lastName: string } | null;
  professional: { id: string; firstName: string; lastName: string } | null;
  service: { id: string; name: string } | null;
}

export interface HomeSummary {
  /** The salon's calendar day, "YYYY-MM-DD". */
  today: string;
  /** The salon's clock, "HH:mm". */
  now: string;
  todayAppointments: HomeAppointmentRow[];
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

/** "HH:mm" with a leading zero ("9:30" sorts after "10:00" otherwise). */
function timeKey(time: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "99:99";
}

function dayOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function person(p: any): HomeAppointmentRow["client"] {
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

@Injectable()
export class HomeSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appointments: AppointmentsService,
  ) {}

  async getHome(user: { id: string; tenantId: string; role: string }, now: Date = new Date()): Promise<HomeSummary> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { timezone: true },
    });
    const { day, time } = salonNow(tenant?.timezone || DEFAULT_TZ, now);
    const empty: HomeSummary = {
      today: day,
      now: time,
      todayAppointments: [],
      pendingConfirmations: { total: 0, items: [] },
      pendingPayments: { total: 0, totalDue: 0, items: [] },
    };

    // Staff: their own agenda (staffAgendaWhere). An account with no professional sees
    // none (as findAll and findPendingPayment answer it).
    let professionalId: string | undefined;
    if (user.role === "staff") {
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
      status: AppointmentStatus.pending,
      scheduledDate: { gte: dayStart },
      ...(professionalId ? staffAgendaWhere(professionalId) : {}),
    };
    const refSelect = { select: { id: true, firstName: true, lastName: true } };

    const [todays, pendingTotal, pendingFirst, owed] = await Promise.all([
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
    ]);

    const todayAppointments = (todays as any[])
      .filter((a) => ACTIVE_TODAY.includes(a.status))
      .map(homeRow)
      .sort(byDateAndTime);

    const owedRows = (owed as any[]).map(homeRow);
    const latestOwed = [...owedRows].sort(byDateAndTime).reverse().slice(0, HOME_LIST_SIZE);

    return {
      today: day,
      now: time,
      todayAppointments,
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
