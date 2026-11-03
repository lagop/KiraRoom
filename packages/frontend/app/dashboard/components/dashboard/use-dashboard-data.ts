"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import apiClient, {
  type AnalyticsOccupancy,
  type AnalyticsStats,
  type AnalyticsTillSales,
  type HomeAppointmentRow,
  type HomeSummary,
} from "@/lib/api";
import { isManager } from "@/lib/dashboard-nav";
import { todayPaymentsFigures, type TodayPaymentRow } from "@/lib/home-dashboard";
import { getCurrentUser } from "@/lib/utils";

export type { HomeAppointmentRow };

/** Analítica's stats (cents; changes in percent, null with nothing to compare). */
export type DashboardStats = AnalyticsStats;

export interface DailyMetric {
  date: string;
  appointments: number;
  revenue: number;
}

/** One slice of the status donut: `status` decides its colour and its name. */
export interface AppointmentStatusData {
  status?: string;
  name: string;
  count: number;
}

export interface DashboardData {
  // From /analytics/overview (owner and admins)
  stats: DashboardStats;
  /** The till's sales without an appointment this month (Ingresos + caja's "caja"). */
  tillSales: AnalyticsTillSales;
  dailyMetrics: DailyMetric[];
  // From /analytics/appointment-status-by-days (owner and admins)
  statusByDays: AppointmentStatusData[];
  /** Paid today less refunds, in cents, and how many payments (the whole salon). */
  todayPaymentsTotal: number;
  todayPaymentsCount: number;
  /** Active clients; a professional's own (the whole salon). */
  totalClients: number;
  /** GET /appointments/home: the salon's day and clock, and the lists. */
  today: string;
  now: string;
  location: HomeSummary["location"];
  todayAppointments: HomeAppointmentRow[];
  /** Active professionals (of the location); a professional: themselves. */
  professionals: HomeSummary["professionals"];
  /** Today's occupancy (owner and admins). */
  occupancy: AnalyticsOccupancy | null;
  pendingConfirmations: HomeSummary["pendingConfirmations"];
  pendingPayments: HomeSummary["pendingPayments"];
  unreadNotificationsCount: number;
}

const EMPTY: DashboardData = {
  stats: {
    totalRevenue: 0,
    totalRevenueWithTill: 0,
    totalAppointments: 0,
    paidAppointments: 0,
    newClients: 0,
    avgOrderValue: 0,
    revenueChange: null,
    appointmentsChange: null,
    clientsChange: null,
    orderValueChange: null,
  },
  tillSales: { totalCents: 0, servicesCents: 0, productsCents: 0, sales: 0, refundedCents: 0 },
  dailyMetrics: [],
  statusByDays: [],
  todayPaymentsTotal: 0,
  todayPaymentsCount: 0,
  totalClients: 0,
  today: "",
  now: "",
  location: null,
  todayAppointments: [],
  professionals: [],
  occupancy: null,
  pendingConfirmations: { total: 0, items: [] },
  pendingPayments: { total: 0, totalDue: 0, items: [] },
  unreadNotificationsCount: 0,
};

/**
 * Everything Inicio shows, each piece asked of the server already counted:
 * Analítica's overview and status breakdown (owner and admins), today's
 * payments, the number of active clients (a page of one row: its `total`),
 * the home lists (GET /appointments/home: today and its team, today's
 * occupancy, to confirm and to charge, five rows each with the true totals)
 * and the unread notifications.
 *
 * `locationId` (Empresa, owner and admins): goes to every call that takes
 * one -- the overview, the status breakdown and the home lists. Today's
 * payments and the clients count have no location: they stay the salon's.
 *
 * It used to download every client, every "pending" appointment of a year
 * back and ahead and every unpaid visit of the salon's history -- thousands
 * of rows -- to show five of each and two counters.
 */
export function useDashboardData(locationId: string | null = null) {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Sections that failed to load. Each request still falls back to an empty
  // value so one failure does not blank the whole dashboard -- but it used to
  // do so silently, showing €0 and 0 clients as if they were real figures.
  const [partialFailures, setPartialFailures] = useState<string[]>([]);
  // The salon's figures (Analítica's overview and status counts, the team,
  // the occupancy) are the owner's and admins': the API answers staff with a
  // 403, so they are not asked for, and the page leaves those cards out.
  const [salonFigures, setSalonFigures] = useState(false);
  // Shown while a location's figures replace the previous ones, instead of
  // blanking the page.
  const [refreshing, setRefreshing] = useState(false);
  // Only the latest request writes: a slow answer for the location chosen
  // before must not replace the one chosen after.
  const latest = useRef(0);

  const fetchData = useCallback(async () => {
    const request = ++latest.current;
    setRefreshing(true);
    setError(null);
    const failed: string[] = [];
    const manager = isManager(getCurrentUser()?.role);
    setSalonFigures(manager);
    const location = manager ? locationId : null;
    const soft = <T,>(name: string, request: Promise<T>, fallback: T) =>
      request.catch((err) => {
        console.error(`Dashboard: ${name} failed to load:`, err);
        failed.push(name);
        return fallback;
      });
    try {
      const [overview, statusByDays, todayPayments, clients, home, unread] = await Promise.all([
        manager ? soft("overview", apiClient.getAnalyticsOverview({ months: 1, locationId: location }), null) : null,
        manager
          ? soft("statusByDays", apiClient.getAppointmentStatusByDays(14, location), [] as any[])
          : ([] as any[]),
        soft("todayPayments", apiClient.getTodayPayments(), [] as any[]),
        soft("clients", apiClient.getClientsPage({ page: 1, pageSize: 1, status: "active" }), null),
        soft("home", apiClient.getHomeSummary(location), null as HomeSummary | null),
        soft("unread", apiClient.getUnreadNotificationCount(), { count: 0 }),
      ]);

      if (request !== latest.current) return;
      const payments = todayPaymentsFigures((todayPayments ?? []) as TodayPaymentRow[]);

      setData({
        stats: overview?.stats ?? EMPTY.stats,
        tillSales: overview?.tillSales ?? EMPTY.tillSales,
        dailyMetrics: overview?.dailyMetrics ?? [],
        statusByDays: (statusByDays as AppointmentStatusData[]) ?? [],
        todayPaymentsTotal: payments.totalCents,
        todayPaymentsCount: payments.count,
        totalClients: clients?.total ?? 0,
        today: home?.today ?? "",
        now: home?.now ?? "",
        location: home?.location ?? null,
        todayAppointments: home?.todayAppointments ?? [],
        professionals: home?.professionals ?? [],
        occupancy: home?.occupancy ?? null,
        pendingConfirmations: home?.pendingConfirmations ?? EMPTY.pendingConfirmations,
        pendingPayments: home?.pendingPayments ?? EMPTY.pendingPayments,
        unreadNotificationsCount: (unread as any)?.count ?? 0,
      });
      setPartialFailures(failed);
    } catch (err) {
      if (request !== latest.current) return;
      console.error("Failed to load dashboard data:", err);
      setError(err instanceof Error ? err.message : "");
    } finally {
      if (request === latest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [locationId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, refreshing, error, partialFailures, salonFigures, refresh: fetchData };
}
