import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  AnalyticsAppointment,
  AppointmentRates,
  Occupancy,
  ProfessionalRef,
  ProfessionalRow,
  STATUS_DISPLAY,
  STATUS_ORDER,
  SalonPeriod,
  TillServiceLine,
  addDays,
  clientRetention,
  closedRates,
  dailyMetrics,
  instantRange,
  lastMonthsPeriod,
  monthlyClosedRates,
  monthlyRevenue,
  monthlyStatusCounts,
  newClientCount,
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
import { timeOffBetween } from "../time-off/time-off-query";
import { VISIT_ROW_ORDER, VISIT_ROW_SELECT } from "../appointments/visit-totals";
import { REFUNDABLE_KINDS, centsLeft } from "../payments/refund-lines";

/**
 * Every figure here is computed from the salon's own rows; the definitions
 * (what counts as revenue, a recurring client, occupancy) live in
 * analytics-metrics.ts next to their tests. Money is in cents throughout, the
 * unit the dashboard already divides by 100.
 */

export interface DashboardStats {
  /**
   * What the period's appointments brought in, in cents, VAT included
   * (revenueCents: paid visits less loyalty rewards, plus money kept on
   * cancelled ones). Till sales without an appointment are `tillSales`.
   */
  totalRevenue: number;
  /** totalRevenue + tillSales.totalCents: appointments and till sales together, cents. */
  totalRevenueWithTill: number;
  /** Appointments booked in the period, cancelled ones excluded. */
  totalAppointments: number;
  paidAppointments: number;
  /** Clients whose first completed visit is in the period (newClientCount), not records created in it. */
  newClients: number;
  /** Revenue of the paid visits / paidAppointments (money kept on cancelled ones aside), in cents. */
  avgOrderValue: number;
  /**
   * Changes against the previous comparable period, in percent; null when
   * the previous figure is 0 (nothing to compare with, see percentChange).
   */
  revenueChange: number | null;
  appointmentsChange: number | null;
  clientsChange: number | null;
  orderValueChange: number | null;
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
  /** Completion, cancellation and no-show rates of the period up to yesterday (closedRates). */
  rates: AppointmentRates;
  tillSales: TillSalesSummary;
  occupancy: Occupancy;
  revenueData: RevenueDataPoint[];
  servicePopularity: ServicePopularity[];
  appointmentStatus: AppointmentStatusData[];
  topServices: { name: string; count: number; revenue: number }[];
  topProfessionals: ProfessionalRow[];
  dailyMetrics: { date: string; appointments: number; revenue: number }[];
}

/**
 * What the till sold without an appointment in the period (S6): products
 * and services, money cents with VAT included, net of what was given back.
 * Visits charged at the till are the appointments' revenue, and gift cards
 * sold are not revenue until they pay for something.
 */
export interface TillSalesSummary {
  totalCents: number;
  servicesCents: number;
  productsCents: number;
  /** Till sales with at least one such line left after refunds. */
  sales: number;
  /** Given back of those lines so far, cents. */
  refundedCents: number;
}

export interface ClientInsights {
  period: SalonPeriod;
  /** Clients whose first completed visit is in the period (newClientCount). */
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

const PROFESSIONAL_REF_SELECT = { id: true, firstName: true, lastName: true, profileImage: true } as const;

/**
 * What every metric needs of an appointment (AnalyticsAppointment). Shared
 * with the multi-location report, so both read the same definitions off the
 * same columns.
 */
export const ANALYTICS_APPOINTMENT_SELECT = {
  status: true,
  paymentStatus: true,
  amountPaid: true,
  // Its loyalty reward (discount.loyalty.moneyCents) is not revenue.
  discount: true,
  scheduledDate: true,
  scheduledTime: true,
  duration: true,
  // A multi-service visit's rows: revenue and time per service and professional.
  services: {
    select: { ...VISIT_ROW_SELECT, professional: { select: PROFESSIONAL_REF_SELECT } },
    orderBy: VISIT_ROW_ORDER as any,
  },
  clientId: true,
  professionalId: true,
  serviceId: true,
  locationId: true,
  // The name it was booked under (appointment-snapshot.ts).
  serviceName: true,
  service: { select: { name: true } },
  professional: { select: PROFESSIONAL_REF_SELECT },
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
  async loadAppointments(tenantId: string, period: SalonPeriod): Promise<AnalyticsAppointment[]> {
    const rows = await this.prisma.appointment.findMany({
      where: { tenantId, scheduledDate: scheduledDateRange(period) },
      select: ANALYTICS_APPOINTMENT_SELECT,
    });
    return rows as unknown as AnalyticsAppointment[];
  }

  /** Of these clients, those with a completed appointment before `day`. */
  private async servedBefore(tenantId: string, clientIds: string[], day: string): Promise<Set<string>> {
    if (clientIds.length === 0) return new Set();
    const rows = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        status: "completed",
        clientId: { in: clientIds },
        scheduledDate: { lt: scheduledDateRange({ start: day, end: day }).gte },
      },
      select: { clientId: true },
      distinct: ["clientId"],
    });
    return new Set(rows.map((r) => r.clientId));
  }

  /** New clients of the period (newClientCount): first completed visit in it. */
  private async countNewClients(
    tenantId: string,
    rows: ReadonlyArray<AnalyticsAppointment>,
    period: SalonPeriod,
  ): Promise<number> {
    const served = [
      ...new Set(rows.filter((a) => a.status === "completed" && a.clientId).map((a) => a.clientId as string)),
    ];
    return newClientCount(served, await this.servedBefore(tenantId, served, period.start));
  }

  private async activeProfessionals(tenantId: string) {
    return this.prisma.professional.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, workingHours: true },
    });
  }

  /**
   * The lines the till sold without an appointment in the period (salon
   * days, by when they were sold): products and services
   * (REFUNDABLE_KINDS, what the till itself sells), each with what is left
   * of it after refunds (centsLeft). A visit charged at the till is a line
   * of kind "appointment" and is the appointment's revenue; gift cards sold
   * are counted when they pay for something.
   */
  private async tillLines(tenantId: string, period: SalonPeriod, timezone: string) {
    const lines = await this.prisma.posSaleLine.findMany({
      where: {
        tenantId,
        kind: { in: [...REFUNDABLE_KINDS] },
        appointmentId: null,
        createdAt: instantRange(period, timezone),
      },
      select: {
        id: true,
        saleId: true,
        kind: true,
        professionalId: true,
        description: true,
        quantity: true,
        totalCents: true,
        refundedQuantity: true,
        refundedCents: true,
      },
    });
    return lines.map((l) => ({ ...l, keptCents: centsLeft(l) }));
  }

  private tillSummary(lines: Array<{ saleId: string; kind: string; keptCents: number; refundedCents: number }>): TillSalesSummary {
    const summary: TillSalesSummary = { totalCents: 0, servicesCents: 0, productsCents: 0, sales: 0, refundedCents: 0 };
    const sales = new Set<string>();
    for (const l of lines) {
      summary.refundedCents += l.refundedCents;
      if (l.keptCents <= 0) continue;
      sales.add(l.saleId);
      summary.totalCents += l.keptCents;
      if (l.kind === "service") summary.servicesCents += l.keptCents;
      else summary.productsCents += l.keptCents;
    }
    summary.sales = sales.size;
    return summary;
  }

  /** Professionals named on till lines, for those with no appointment in the period. */
  private async directory(tenantId: string, ids: string[]): Promise<Map<string, ProfessionalRef>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.professional.findMany({
      where: { tenantId, id: { in: ids } },
      select: PROFESSIONAL_REF_SELECT,
    });
    return new Map(rows.map((p) => [p.id, p]));
  }

  /** Per-professional figures (topProfessionals) with the till's services added (D6). */
  private async professionalRows(
    tenantId: string,
    rows: ReadonlyArray<AnalyticsAppointment>,
    tillServices: TillServiceLine[],
    today: string,
    limit: number,
  ): Promise<ProfessionalRow[]> {
    const ids = [
      ...new Set(tillServices.filter((l) => l.keptCents > 0).map((l) => l.professionalId).filter((id): id is string => !!id)),
    ];
    const directory = await this.directory(tenantId, ids);
    return topProfessionals(rows, limit, { today, tillServices, directory });
  }

  /**
   * The overview for the last `months` calendar months of the salon (this
   * month so far included), compared with the same days `months` months
   * earlier.
   */
  async getOverview(tenantId: string, months: number = 6): Promise<AnalyticsOverview> {
    const { today, timezone } = await this.todayFor(tenantId);
    const period = lastMonthsPeriod(today, months);
    const previous = previousPeriod(period, months);

    const [current, before, professionals, timeOff, till] = await Promise.all([
      this.loadAppointments(tenantId, period),
      this.loadAppointments(tenantId, previous),
      this.activeProfessionals(tenantId),
      // Closures and absences come out of working time (see occupancy).
      timeOffBetween(this.prisma as any, tenantId, period.start, period.end),
      this.tillLines(tenantId, period, timezone),
    ]);
    const tillServices = till.filter((l) => l.kind === "service");
    const [newClients, previousNewClients, professionalRows] = await Promise.all([
      this.countNewClients(tenantId, current, period),
      this.countNewClients(tenantId, before, previous),
      this.professionalRows(tenantId, current, tillServices, today, 5),
    ]);

    const now = summarize(current);
    const then = summarize(before);
    const tillSales = this.tillSummary(till);

    return {
      period,
      previousPeriod: previous,
      timezone,
      currencyUnit: "cents",
      stats: {
        totalRevenue: now.revenue,
        totalRevenueWithTill: now.revenue + tillSales.totalCents,
        totalAppointments: now.appointments,
        paidAppointments: now.paidAppointments,
        newClients,
        avgOrderValue: now.avgTicket,
        revenueChange: percentChange(now.revenue, then.revenue),
        appointmentsChange: percentChange(now.appointments, then.appointments),
        clientsChange: percentChange(newClients, previousNewClients),
        orderValueChange: percentChange(now.avgTicket, then.avgTicket),
      },
      rates: closedRates(current, today),
      tillSales,
      occupancy: occupancy(professionals, current, period, timeOff, timezone),
      revenueData: monthlyRevenue(current, period),
      servicePopularity: servicePopularity(current, 10),
      appointmentStatus: this.statusBreakdown(current),
      topServices: topServices(current, 5),
      topProfessionals: professionalRows,
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
  async getAppointmentStatusByDays(tenantId: string, days: number): Promise<AppointmentStatusData[]> {
    const { today } = await this.todayFor(tenantId);
    const n = Math.max(1, Math.min(366, Math.floor(days) || 7));
    const period = { start: addDays(today, -(n - 1)), end: today };
    const rows = await this.prisma.appointment.findMany({
      where: { tenantId, scheduledDate: scheduledDateRange(period) },
      select: { status: true },
    });
    return this.statusBreakdown(rows);
  }

  /**
   * The completion, cancellation and no-show rates (closedRates: closed
   * appointments up to yesterday), the one definition the page uses. Over
   * the last `days` salon days, or the last `months` salon months with one
   * entry per month as well.
   */
  async getAppointmentRates(
    tenantId: string,
    window: { days?: number; months?: number },
  ): Promise<{ period: SalonPeriod } & AppointmentRates & { byMonth?: Array<{ month: string } & AppointmentRates> }> {
    const { today } = await this.todayFor(tenantId);
    let period: SalonPeriod;
    if (window.months) {
      period = lastMonthsPeriod(today, window.months);
    } else {
      const n = Math.max(1, Math.min(366, Math.floor(window.days ?? 7) || 7));
      period = { start: addDays(today, -(n - 1)), end: today };
    }
    const rows = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        scheduledDate: scheduledDateRange(period),
        status: { in: ["completed", "cancelled", "no_show"] },
      },
      select: { status: true, scheduledDate: true },
    });
    // `period` is the window asked for; `through` (yesterday) is the last day counted.
    return {
      period,
      ...closedRates(rows, today),
      ...(window.months ? { byMonth: monthlyClosedRates(rows, period, today) } : {}),
    };
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

  /**
   * Per-professional performance over the period (topProfessionals): their
   * share of the appointments' revenue plus the services they did that the
   * till sold without an appointment, and how their appointments closed.
   */
  async getTopProfessionals(tenantId: string, period: SalonPeriod, limit: number): Promise<ProfessionalRow[]> {
    const { today, timezone } = await this.todayFor(tenantId);
    const [rows, till] = await Promise.all([
      this.loadAppointments(tenantId, period),
      this.tillLines(tenantId, period, timezone),
    ]);
    return this.professionalRows(
      tenantId,
      rows,
      till.filter((l) => l.kind === "service"),
      today,
      limit,
    );
  }

  /**
   * New, served and recurring clients over the last `months` salon months.
   * "Recurring" is defined in clientRetention(); it replaces an estimate of
   * 40 % of the appointment count that the panel showed as a measurement.
   */
  async getClientInsights(tenantId: string, months: number): Promise<ClientInsights> {
    const { today } = await this.todayFor(tenantId);
    const period = lastMonthsPeriod(today, months);
    const range = scheduledDateRange(period);

    const [completed, totalAppointments] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { tenantId, status: "completed", scheduledDate: range },
        select: { clientId: true },
      }),
      this.prisma.appointment.count({
        where: { tenantId, scheduledDate: range, status: { not: "cancelled" } },
      }),
    ]);

    const servedIds = [...new Set(completed.map((a) => a.clientId))];
    const earlier = await this.servedBefore(tenantId, servedIds, period.start);

    const retention = clientRetention(
      completed.map((a) => a.clientId),
      earlier,
    );

    return {
      period,
      // First completed visit in the period (newClientCount), like the overview.
      newClients: newClientCount(servedIds, earlier),
      clientsServed: retention.clientsServed,
      returningClients: retention.returningClients,
      totalAppointments,
      retentionRate: retention.retentionRate,
    };
  }
}
