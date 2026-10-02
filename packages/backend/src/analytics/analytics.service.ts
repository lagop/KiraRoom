import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  AnalyticsAppointment,
  Occupancy,
  ProfessionalRow,
  STATUS_DISPLAY,
  STATUS_ORDER,
  SalonPeriod,
  addDays,
  appointmentDay,
  clientRetention,
  dailyMetrics,
  instantRange,
  lastMonthsPeriod,
  monthlyRevenue,
  monthlyStatusCounts,
  occupancy,
  percentChange,
  previousPeriod,
  salonToday,
  scheduledDateRange,
  servicePopularity,
  summarize,
  topProfessionals,
  topServices,
} from "./analytics-metrics";

/**
 * Every figure here is computed from the salon's own rows; the definitions
 * (what counts as revenue, a recurring client, occupancy) live in
 * analytics-metrics.ts next to their tests. Money is in cents throughout, the
 * unit the dashboard already divides by 100.
 */

export interface DashboardStats {
  /** Paid, non-cancelled appointments in the period, in cents. */
  totalRevenue: number;
  /** Appointments booked in the period, cancelled ones excluded. */
  totalAppointments: number;
  paidAppointments: number;
  newClients: number;
  /** totalRevenue / paidAppointments, in cents. */
  avgOrderValue: number;
  /** Changes against the previous comparable period, in percent. */
  revenueChange: number;
  appointmentsChange: number;
  clientsChange: number;
  orderValueChange: number;
}

export interface RevenueDataPoint {
  /** "YYYY-MM" */
  month: string;
  revenue: number;
}

export interface ServicePopularity {
  name: string;
  count: number;
  percentage: number;
}

export interface AppointmentStatusData {
  status: string;
  name: string;
  count: number;
  color: string;
}

export interface AnalyticsOverview {
  period: SalonPeriod;
  previousPeriod: SalonPeriod;
  timezone: string;
  currencyUnit: "cents";
  stats: DashboardStats;
  occupancy: Occupancy;
  revenueData: RevenueDataPoint[];
  servicePopularity: ServicePopularity[];
  appointmentStatus: AppointmentStatusData[];
  topServices: { name: string; count: number; revenue: number }[];
  topProfessionals: ProfessionalRow[];
  dailyMetrics: { date: string; appointments: number; revenue: number }[];
}

export interface ClientInsights {
  period: SalonPeriod;
  newClients: number;
  /** Distinct clients with at least one completed appointment in the period. */
  clientsServed: number;
  /** See clientRetention(): served in the period and came back, or had come before. */
  returningClients: number;
  totalAppointments: number;
  /** returningClients / clientsServed, in percent. */
  retentionRate: number;
}

const STATUS_COLORS: Record<string, string> = {
  completed: "bg-green-500",
  confirmed: "bg-blue-500",
  pending: "bg-yellow-500",
  cancelled: "bg-red-500",
  no_show: "bg-gray-500",
  in_progress: "bg-purple-500",
};

const DEFAULT_TIMEZONE = "Europe/Madrid";

const APPOINTMENT_FIELDS = {
  status: true,
  paymentStatus: true,
  amountPaid: true,
  totalAmount: true,
  price: true,
  scheduledDate: true,
  duration: true,
  clientId: true,
  professionalId: true,
  serviceId: true,
  locationId: true,
  service: { select: { name: true } },
  professional: {
    select: { id: true, firstName: true, lastName: true, profileImage: true },
  },
} as const;

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  /** The salon's timezone: period boundaries follow its calendar, not the server's. */
  async timezoneOf(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return tenant?.timezone || DEFAULT_TIMEZONE;
  }

  async todayFor(tenantId: string): Promise<{ today: string; timezone: string }> {
    const timezone = await this.timezoneOf(tenantId);
    return { today: salonToday(timezone), timezone };
  }

  /** Appointments scheduled in the period, with what every metric needs. */
  async loadAppointments(
    tenantId: string,
    period: SalonPeriod,
    professionalId?: string | null,
  ): Promise<AnalyticsAppointment[]> {
    const rows = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        scheduledDate: scheduledDateRange(period),
        ...(professionalId ? { professionalId } : {}),
      },
      select: APPOINTMENT_FIELDS,
    });
    return rows as unknown as AnalyticsAppointment[];
  }

  private async countNewClients(
    tenantId: string,
    period: SalonPeriod,
    timezone: string,
    professionalId?: string | null,
  ): Promise<number> {
    return this.prisma.client.count({
      where: {
        tenantId,
        createdAt: instantRange(period, timezone),
        // For Staff: only clients who have booked with them.
        ...(professionalId ? { appointments: { some: { professionalId } } } : {}),
      },
    });
  }

  private async activeProfessionals(tenantId: string, professionalId?: string | null) {
    return this.prisma.professional.findMany({
      where: { tenantId, isActive: true, ...(professionalId ? { id: professionalId } : {}) },
      select: { id: true, workingHours: true },
    });
  }

  /**
   * The overview for the last `months` calendar months of the salon (this
   * month so far included), compared with the same days `months` months
   * earlier.
   */
  async getOverview(
    tenantId: string,
    months: number = 6,
    professionalId?: string | null,
  ): Promise<AnalyticsOverview> {
    const { today, timezone } = await this.todayFor(tenantId);
    const period = lastMonthsPeriod(today, months);
    const previous = previousPeriod(period, months);

    const [current, before, newClients, previousNewClients, professionals] =
      await Promise.all([
        this.loadAppointments(tenantId, period, professionalId),
        this.loadAppointments(tenantId, previous, professionalId),
        this.countNewClients(tenantId, period, timezone, professionalId),
        this.countNewClients(tenantId, previous, timezone, professionalId),
        this.activeProfessionals(tenantId, professionalId),
      ]);

    const now = summarize(current);
    const then = summarize(before);

    return {
      period,
      previousPeriod: previous,
      timezone,
      currencyUnit: "cents",
      stats: {
        totalRevenue: now.revenue,
        totalAppointments: now.appointments,
        paidAppointments: now.paidAppointments,
        newClients,
        avgOrderValue: now.avgTicket,
        revenueChange: percentChange(now.revenue, then.revenue),
        appointmentsChange: percentChange(now.appointments, then.appointments),
        clientsChange: percentChange(newClients, previousNewClients),
        orderValueChange: percentChange(now.avgTicket, then.avgTicket),
      },
      occupancy: occupancy(professionals, current, period),
      revenueData: monthlyRevenue(current, period),
      servicePopularity: servicePopularity(current, 10),
      appointmentStatus: this.statusBreakdown(current),
      topServices: topServices(current, 5),
      topProfessionals: topProfessionals(current, 5),
      dailyMetrics: dailyMetrics(current, period),
    };
  }

  private statusBreakdown(
    rows: ReadonlyArray<{ status: string }>,
  ): AppointmentStatusData[] {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return STATUS_ORDER.filter((s) => counts.has(s)).map((s) => ({
      status: s,
      name: STATUS_DISPLAY[s],
      count: counts.get(s)!,
      color: STATUS_COLORS[s] || "bg-gray-500",
    }));
  }

  /** Status breakdown of the last `days` salon days, today included. */
  async getAppointmentStatusByDays(
    tenantId: string,
    days: number,
  ): Promise<AppointmentStatusData[]> {
    const { today } = await this.todayFor(tenantId);
    const n = Math.max(1, Math.min(366, Math.floor(days) || 7));
    const period = { start: addDays(today, -(n - 1)), end: today };
    const rows = await this.prisma.appointment.findMany({
      where: { tenantId, scheduledDate: scheduledDateRange(period) },
      select: { status: true },
    });
    return this.statusBreakdown(rows);
  }

  /** One status, month by month, over the last `months` salon months. */
  async getAppointmentStatusEvolution(
    tenantId: string,
    status: string,
    months: number = 6,
  ): Promise<{ period: string; count: number }[]> {
    const display =
      STATUS_DISPLAY[status] ??
      Object.values(STATUS_DISPLAY).find((d) => d === status) ??
      status;
    const evolution = await this.getAppointmentStatusesEvolution(tenantId, months);
    return evolution.map((m) => ({
      period: m.period,
      count: Number(m[display] ?? 0),
    }));
  }

  /** Every status, month by month (stacked chart data), months as "YYYY-MM". */
  async getAppointmentStatusesEvolution(
    tenantId: string,
    months: number = 6,
  ): Promise<Array<{ period: string } & Record<string, number | string>>> {
    const { today } = await this.todayFor(tenantId);
    const period = lastMonthsPeriod(today, months);
    const rows = await this.prisma.appointment.findMany({
      where: { tenantId, scheduledDate: scheduledDateRange(period) },
      select: { status: true, scheduledDate: true },
    });
    return monthlyStatusCounts(rows, period);
  }

  async getTopProfessionals(
    tenantId: string,
    period: SalonPeriod,
    limit: number,
    professionalId?: string | null,
  ): Promise<ProfessionalRow[]> {
    const rows = await this.loadAppointments(tenantId, period, professionalId);
    return topProfessionals(rows, limit);
  }

  /** Revenue report for explicit salon days (both inclusive). Cents. */
  async getRevenueReport(
    tenantId: string,
    period: SalonPeriod,
  ): Promise<{
    period: SalonPeriod;
    total: number;
    byDay: { date: string; revenue: number }[];
    byService: { service: string; revenue: number }[];
    byProfessional: { professional: string; revenue: number }[];
  }> {
    const rows = await this.loadAppointments(tenantId, period);
    return {
      period,
      total: summarize(rows).revenue,
      byDay: dailyMetrics(rows, period).map((d) => ({ date: d.date, revenue: d.revenue })),
      byService: topServices(rows, 100).map((s) => ({ service: s.name, revenue: s.revenue })),
      byProfessional: topProfessionals(rows, 100).map((p) => ({
        professional: p.name,
        revenue: p.revenue,
      })),
    };
  }

  async getAppointmentsReport(
    tenantId: string,
    period: SalonPeriod,
  ): Promise<{
    period: SalonPeriod;
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    byDay: { date: string; count: number }[];
    byProfessional: { professional: string; count: number }[];
  }> {
    const rows = await this.loadAppointments(tenantId, period);
    const byProfMap = new Map<string, number>();
    for (const a of rows) {
      const name = a.professional
        ? `${a.professional.firstName} ${a.professional.lastName}`.trim()
        : "Sin profesional";
      byProfMap.set(name, (byProfMap.get(name) ?? 0) + 1);
    }
    const byDayMap = new Map<string, number>();
    for (const a of rows) {
      const day = appointmentDay(a.scheduledDate);
      byDayMap.set(day, (byDayMap.get(day) ?? 0) + 1);
    }
    return {
      period,
      total: rows.length,
      completed: rows.filter((a) => a.status === "completed").length,
      cancelled: rows.filter((a) => a.status === "cancelled").length,
      noShow: rows.filter((a) => a.status === "no_show").length,
      byDay: [...byDayMap.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      byProfessional: [...byProfMap.entries()]
        .map(([professional, count]) => ({ professional, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  /**
   * New, served and recurring clients over the last `months` salon months.
   * "Recurring" is defined in clientRetention(); it replaces an estimate of
   * 40 % of the appointment count that the panel showed as a measurement.
   */
  async getClientInsights(tenantId: string, months: number): Promise<ClientInsights> {
    const { today, timezone } = await this.todayFor(tenantId);
    const period = lastMonthsPeriod(today, months);
    const range = scheduledDateRange(period);

    const [newClients, completed, totalAppointments] = await Promise.all([
      this.countNewClients(tenantId, period, timezone),
      this.prisma.appointment.findMany({
        where: { tenantId, status: "completed", scheduledDate: range },
        select: { clientId: true },
      }),
      this.prisma.appointment.count({
        where: { tenantId, scheduledDate: range, status: { not: "cancelled" } },
      }),
    ]);

    const servedIds = [...new Set(completed.map((a) => a.clientId))];
    const earlier = servedIds.length
      ? await this.prisma.appointment.findMany({
          where: {
            tenantId,
            status: "completed",
            clientId: { in: servedIds },
            scheduledDate: { lt: range.gte },
          },
          select: { clientId: true },
          distinct: ["clientId"],
        })
      : [];

    const retention = clientRetention(
      completed.map((a) => a.clientId),
      new Set(earlier.map((a) => a.clientId)),
    );

    return {
      period,
      newClients,
      clientsServed: retention.clientsServed,
      returningClients: retention.returningClients,
      totalAppointments,
      retentionRate: retention.retentionRate,
    };
  }
}
