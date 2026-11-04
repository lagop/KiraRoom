import { Injectable } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { getActiveTenant } from "./saas.helpers";
import { safeTimeZone } from "../gift-cards/gift-card-expiry";
import { monthlyPlanRevenue } from "./saas.service";
import {
  consoleMonths,
  monthLifecycle,
  paidChurnRate,
  percentChange,
  PAYING_TENANT_WHERE,
  PLATFORM_TENANT_WHERE,
  scheduledInMonth,
  type ConsoleMonth,
} from "./platform-metrics";

/**
 * Figures for the platform console's home, Analytics and per-salon pages
 * (audit 8 D3, D4, D5, D12; T8).
 *
 * Money: KiraRoom's own revenue is MRR (what the paying salons' plans and
 * add-ons bill). "Salon takings" is something else: what the salons charged
 * their clients for appointments marked paid, in euros (Appointment.price is
 * a Decimal in euros, not cents). The console used to divide it by 100 and
 * show it next to MRR as "revenue". Where takings should live on the home
 * page is an owner decision still pending, so they stay there, labelled as
 * the salons' takings.
 *
 * Months are Madrid calendar months. Test appointments (`isTest`), deleted
 * salons and our own test salons (PLATFORM_TENANT_WHERE) are left out.
 */
export interface SaasAnalytics {
  totalTenants: number;
  totalUsers: number;
  totalClients: number;
  totalAppointments: number;
  /** Paid appointments of all time, in euros: the salons' takings, not KiraRoom's. */
  salonTakingsTotal: number;
  /** KiraRoom's monthly recurring revenue, in euros, from paying salons only. */
  mrr: number;
  arr: number;
  /** Salons `active` on a Stripe subscription. */
  payingTenants: number;
  /** `active` salons with no Stripe subscription: they bill nothing and are out of MRR. */
  activeWithoutBilling: number;
  avgMrrPerPayingSalon: number;
  trialTenants: number;
  pastDueTenants: number;
  suspendedTenants: number;
  cancelledTenants: number;
  newTenantsThisMonth: number;
  newUsersThisMonth: number;
  /** This Madrid month. */
  paidCancellationsThisMonth: number;
  expiredTrialsThisMonth: number;
  paidChurnRateThisMonth: number | null;
  trialsEndedThisMonth: number;
  trialsConvertedThisMonth: number;
  trialConversionRateThisMonth: number | null;
  topCountries: { country: string; count: number }[];
  planDistribution: { plan: string; count: number }[];
  /** How "internal" salons were told apart, shown in the console. */
  excludedTenantsRule: string;
}

const PLATFORM_USER_WHERE: Prisma.UserWhereInput = {
  role: { not: UserRole.saas_owner },
  isActive: true,
  tenant: PLATFORM_TENANT_WHERE,
};

const PAID_APPOINTMENT_WHERE: Prisma.AppointmentWhereInput = {
  paymentStatus: "paid",
  isTest: false,
};

const euros = (v: Prisma.Decimal | number | null | undefined) => Math.round((Number(v) || 0) * 100) / 100;

@Injectable()
export class SaasAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getPlatformAnalytics(now: Date = new Date()): Promise<SaasAnalytics> {
    const [thisMonth] = consoleMonths(1, now);

    const [
      tenants,
      users,
      clients,
      appointments,
      takings,
      paying,
      statusBreakdown,
      countryAggregation,
      planAggregation,
      newUsersThisMonth,
      lifecycleRows,
    ] = await Promise.all([
      this.prisma.tenant.count({ where: PLATFORM_TENANT_WHERE }),
      this.prisma.user.count({ where: PLATFORM_USER_WHERE }),
      this.prisma.client.count({ where: { tenant: PLATFORM_TENANT_WHERE } }),
      this.prisma.appointment.count({ where: { isTest: false, tenant: PLATFORM_TENANT_WHERE } }),
      this.prisma.appointment.aggregate({
        where: { ...PAID_APPOINTMENT_WHERE, tenant: PLATFORM_TENANT_WHERE },
        _sum: { price: true },
      }),
      // Every paying tenant with its location count: Empresa is billed per
      // location, so a per-plan count undercounts it.
      this.prisma.tenant.findMany({
        where: PAYING_TENANT_WHERE,
        select: {
          plan: true,
          maxLocations: true,
          // Paid add-ons only: a manual grant (no Stripe item) bills nothing.
          tenantAddOns: {
            where: { status: "active", stripeSubscriptionItemId: { not: null } },
            select: {
              monthlyPriceCents: true,
              addOn: { select: { monthlyPriceCents: true, metered: true } },
            },
          },
        },
      }),
      this.prisma.tenant.groupBy({
        by: ["subscriptionStatus"],
        where: PLATFORM_TENANT_WHERE,
        _count: true,
      }),
      this.prisma.tenant.groupBy({
        by: ["country"],
        where: PLATFORM_TENANT_WHERE,
        _count: true,
        orderBy: { _count: { country: "desc" } },
        take: 5,
      }),
      this.prisma.tenant.groupBy({
        by: ["plan"],
        where: PLATFORM_TENANT_WHERE,
        _count: true,
        orderBy: { _count: { plan: "desc" } },
      }),
      this.prisma.user.count({
        where: { ...PLATFORM_USER_WHERE, createdAt: { gte: thisMonth.start, lt: thisMonth.end } },
      }),
      this.lifecycleRows(thisMonth.start),
    ]);

    const statusCount = (s: string) =>
      statusBreakdown.find((r) => r.subscriptionStatus === s)?._count ?? 0;

    const mrr = paying.reduce(
      (sum, t) =>
        sum +
        monthlyPlanRevenue(
          t.plan,
          t.maxLocations,
          (t.tenantAddOns ?? [])
            .filter((a) => !a.addOn?.metered)
            .map((a) => a.monthlyPriceCents ?? a.addOn?.monthlyPriceCents ?? 0),
        ),
      0,
    );
    const mrrRounded = Math.round(mrr * 100) / 100;
    const payingTenants = paying.length;
    const month = monthLifecycle(lifecycleRows, thisMonth, now);

    return {
      totalTenants: tenants,
      totalUsers: users,
      totalClients: clients,
      totalAppointments: appointments,
      salonTakingsTotal: euros(takings._sum.price),
      mrr: mrrRounded,
      arr: Math.round(mrrRounded * 12 * 100) / 100,
      payingTenants,
      activeWithoutBilling: Math.max(0, statusCount("active") - payingTenants),
      avgMrrPerPayingSalon: payingTenants > 0 ? Math.round((mrrRounded / payingTenants) * 100) / 100 : 0,
      trialTenants: statusCount("trialing"),
      pastDueTenants: statusCount("past_due"),
      suspendedTenants: statusCount("suspended"),
      cancelledTenants: statusCount("cancelled"),
      newTenantsThisMonth: month.newSalons,
      newUsersThisMonth,
      paidCancellationsThisMonth: month.paidCancellations,
      expiredTrialsThisMonth: month.expiredTrials,
      paidChurnRateThisMonth: paidChurnRate(month.paidCancellations, payingTenants),
      trialsEndedThisMonth: month.trialsEnded,
      trialsConvertedThisMonth: month.trialsConverted,
      trialConversionRateThisMonth: month.trialConversionRate,
      topCountries: countryAggregation.map((c) => ({ country: c.country, count: c._count })),
      planDistribution: planAggregation.map((p) => ({ plan: p.plan, count: p._count })),
      excludedTenantsRule: "deleted, or slug starting with zz-",
    };
  }

  async getPlatformGrowthMetrics(months: number, now: Date = new Date()) {
    // Always compute at least two months so "vs last month" has a base.
    const windows = consoleMonths(Math.max(2, months), now);

    const [lifecycleRows, payingNow, perMonth] = await Promise.all([
      this.lifecycleRows(windows[0].start),
      this.prisma.tenant.count({ where: PAYING_TENANT_WHERE }),
      Promise.all(windows.map((w) => this.platformMonth(w))),
    ]);

    const rows = windows.map((w, i) => ({
      month: w.month,
      ...perMonth[i],
      ...monthLifecycle(lifecycleRows, w, now),
    }));
    const visible = rows.slice(-months);
    const current = rows[rows.length - 1];
    const previous = rows[rows.length - 2];

    return {
      period: `${months}_months`,
      timeZone: "Europe/Madrid",
      salonsEvolution: visible.map((r) => ({ month: r.month, total: r.totalSalons, new: r.newSalons })),
      salonTakingsEvolution: visible.map((r) => ({ month: r.month, value: r.takings })),
      usersEvolution: visible.map((r) => ({ month: r.month, total: r.totalUsers, new: r.newUsers })),
      appointmentsEvolution: visible.map((r) => ({ month: r.month, value: r.appointments })),
      lifecycleEvolution: visible.map((r) => ({
        month: r.month,
        paidCancellations: r.paidCancellations,
        expiredTrials: r.expiredTrials,
        trialsEnded: r.trialsEnded,
        trialsConverted: r.trialsConverted,
        trialConversionRate: r.trialConversionRate,
      })),
      summary: {
        salonTakingsThisMonth: current.takings,
        salonTakingsLastMonth: previous.takings,
        salonTakingsChangePercent: percentChange(current.takings, previous.takings),
        newSalonsThisMonth: current.newSalons,
        newSalonsLastMonth: previous.newSalons,
        newSalonsChangePercent: percentChange(current.newSalons, previous.newSalons),
        newUsersThisMonth: current.newUsers,
        newUsersLastMonth: previous.newUsers,
        newUsersChangePercent: percentChange(current.newUsers, previous.newUsers),
        paidCancellationsThisMonth: current.paidCancellations,
        paidCancellationsLastMonth: previous.paidCancellations,
        expiredTrialsThisMonth: current.expiredTrials,
        expiredTrialsLastMonth: previous.expiredTrials,
        paidChurnRate: paidChurnRate(current.paidCancellations, payingNow),
        trialConversionRateThisMonth: current.trialConversionRate,
        trialConversionRateLastMonth: previous.trialConversionRate,
      },
    };
  }

  async getTenantStats(id: string, now: Date = new Date()) {
    const tenant = await getActiveTenant(this.prisma, id);
    const [lastMonth, thisMonth] = consoleMonths(2, now, safeTimeZone(tenant.timezone));

    const [totalClients, totalAppointments, totalTakings, thisMonthStats, lastMonthStats] = await Promise.all([
      this.prisma.client.count({ where: { tenantId: id } }),
      this.prisma.appointment.count({ where: { tenantId: id, isTest: false } }),
      this.prisma.appointment.aggregate({
        where: { tenantId: id, ...PAID_APPOINTMENT_WHERE },
        _sum: { price: true },
      }),
      this.tenantMonth(id, thisMonth),
      this.tenantMonth(id, lastMonth),
    ]);

    return {
      tenantId: id,
      tenantName: tenant.name,
      plan: tenant.plan,
      subscriptionStatus: tenant.subscriptionStatus,
      totalClients,
      totalAppointments,
      /** Euros the salon charged for paid appointments: its takings, not KiraRoom's revenue. */
      salonTakingsTotal: euros(totalTakings._sum.price),
      appointmentsThisMonth: thisMonthStats.appointments,
      appointmentsLastMonth: lastMonthStats.appointments,
      appointmentsChange: percentChange(thisMonthStats.appointments, lastMonthStats.appointments),
      salonTakingsThisMonth: thisMonthStats.takings,
      salonTakingsLastMonth: lastMonthStats.takings,
      salonTakingsChange: percentChange(thisMonthStats.takings, lastMonthStats.takings),
    };
  }

  async getSalonGrowthMetrics(tenantId: string, months: number, now: Date = new Date()) {
    const tenant = await getActiveTenant(this.prisma, tenantId);
    const windows = consoleMonths(Math.max(2, months), now, safeTimeZone(tenant.timezone));

    const perMonth = await Promise.all(
      windows.map(async (w) => {
        const [stats, newClients, totalClientsAtEnd] = await Promise.all([
          this.tenantMonth(tenantId, w),
          this.prisma.client.count({ where: { tenantId, createdAt: { gte: w.start, lt: w.end } } }),
          this.prisma.client.count({ where: { tenantId, createdAt: { lt: w.end } } }),
        ]);
        return { month: w.month, ...stats, newClients, totalClientsAtEnd };
      }),
    );
    const visible = perMonth.slice(-months);
    const current = perMonth[perMonth.length - 1];
    const previous = perMonth[perMonth.length - 2];

    return {
      salonId: tenantId,
      period: `${months}_months`,
      salonTakingsEvolution: visible.map((m) => ({ month: m.month, value: m.takings })),
      appointmentsEvolution: visible.map((m) => ({ month: m.month, value: m.appointments })),
      clientsEvolution: visible.map((m) => ({
        month: m.month,
        value: m.totalClientsAtEnd,
        newClients: m.newClients,
        returningClients: m.totalClientsAtEnd - m.newClients,
      })),
      summary: {
        salonTakingsThisMonth: current.takings,
        salonTakingsLastMonth: previous.takings,
        salonTakingsChangePercent: percentChange(current.takings, previous.takings),
        appointmentsThisMonth: current.appointments,
        appointmentsLastMonth: previous.appointments,
        appointmentsChangePercent: percentChange(current.appointments, previous.appointments),
        newClientsThisMonth: current.newClients,
        newClientsLastMonth: previous.newClients,
        newClientsChangePercent: percentChange(current.newClients, previous.newClients),
      },
    };
  }

  /** Lifecycle dates of the platform salons that could matter from `since` on. */
  private lifecycleRows(since: Date) {
    return this.prisma.tenant.findMany({
      where: {
        ...PLATFORM_TENANT_WHERE,
        OR: [{ createdAt: { gte: since } }, { cancelledAt: { gte: since } }, { trialEnd: { gte: since } }],
      },
      select: { createdAt: true, cancelledAt: true, firstPaidAt: true, trialEnd: true },
    });
  }

  private async platformMonth(w: ConsoleMonth) {
    const [totalSalons, takings, totalUsers, newUsers, appointments] = await Promise.all([
      this.prisma.tenant.count({ where: { ...PLATFORM_TENANT_WHERE, createdAt: { lt: w.end } } }),
      this.prisma.appointment.aggregate({
        where: { ...PAID_APPOINTMENT_WHERE, tenant: PLATFORM_TENANT_WHERE, scheduledDate: scheduledInMonth(w) },
        _sum: { price: true },
      }),
      this.prisma.user.count({ where: { ...PLATFORM_USER_WHERE, createdAt: { lt: w.end } } }),
      this.prisma.user.count({ where: { ...PLATFORM_USER_WHERE, createdAt: { gte: w.start, lt: w.end } } }),
      this.prisma.appointment.count({
        where: { isTest: false, tenant: PLATFORM_TENANT_WHERE, scheduledDate: scheduledInMonth(w) },
      }),
    ]);
    return { totalSalons, takings: euros(takings._sum.price), totalUsers, newUsers, appointments };
  }

  /** A salon's appointments and takings in a month, by the visit's date. */
  private async tenantMonth(tenantId: string, w: ConsoleMonth) {
    const [appointments, takings] = await Promise.all([
      this.prisma.appointment.count({
        where: { tenantId, isTest: false, scheduledDate: scheduledInMonth(w) },
      }),
      this.prisma.appointment.aggregate({
        where: { tenantId, ...PAID_APPOINTMENT_WHERE, scheduledDate: scheduledInMonth(w) },
        _sum: { price: true },
      }),
    ]);
    return { appointments, takings: euros(takings._sum.price) };
  }
}
