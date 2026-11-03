"use client";

import { useCallback, useEffect, useState } from "react";
import apiClient, { type HomeAppointmentRow, type HomeSummary } from "@/lib/api";
import { isManager } from "@/lib/dashboard-nav";
import { todayPaymentsFigures, type TodayPaymentRow } from "@/lib/home-dashboard";
import { getCurrentUser } from "@/lib/utils";

export type { HomeAppointmentRow };

export interface DashboardStats {
  /** Appointments' revenue (cents), Analítica's "Ingresos de citas". */
  totalRevenue: number;
  totalAppointments: number;
  newClients: number;
  avgOrderValue: number;
  /** Null when the previous period had nothing to compare with. */
  revenueChange: number | null;
  appointmentsChange: number | null;
  clientsChange: number | null;
  orderValueChange: number | null;
}

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
  dailyMetrics: DailyMetric[];
  // From /analytics/appointment-status-by-days (owner and admins)
  statusByDays: AppointmentStatusData[];
  /** Paid today less refunds, in cents, and how many payments. */
  todayPaymentsTotal: number;
  todayPaymentsCount: number;
  /** Owner and admins only (staff cannot list the team). */
  activeProfessionals: number;
  /** Active clients; a professional's own. */
  totalClients: number;
  /** GET /appointments/home: the salon's day and clock, and the lists. */
  today: string;
  now: string;
  todayAppointments: HomeAppointmentRow[];
  pendingConfirmations: HomeSummary["pendingConfirmations"];
  pendingPayments: HomeSummary["pendingPayments"];
  unreadNotificationsCount: number;
}

const EMPTY: DashboardData = {
  stats: {
    totalRevenue: 0,
    totalAppointments: 0,
    newClients: 0,
    avgOrderValue: 0,
    revenueChange: null,
    appointmentsChange: null,
    clientsChange: null,
    orderValueChange: null,
  },
  dailyMetrics: [],
  statusByDays: [],
  todayPaymentsTotal: 0,
  todayPaymentsCount: 0,
  activeProfessionals: 0,
  totalClients: 0,
  today: "",
  now: "",
  todayAppointments: [],
  pendingConfirmations: { total: 0, items: [] },
  pendingPayments: { total: 0, totalDue: 0, items: [] },
  unreadNotificationsCount: 0,
};

/**
 * Everything Inicio shows, each piece asked of the server already counted:
 * Analítica's overview and status breakdown (owner and admins), today's
 * payments, the number of active clients (a page of one row: its `total`),
 * the team (owner and admins), the home lists (GET /appointments/home: today,
 * to confirm and to charge, five rows each with the true totals) and the
 * unread notifications.
 *
 * It used to download every client, every "pending" appointment of a year
 * back and ahead and every unpaid visit of the salon's history -- thousands
 * of rows -- to show five of each and two counters.
 */
export function useDashboardData() {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Sections that failed to load. Each request still falls back to an empty
  // value so one failure does not blank the whole dashboard -- but it used to
  // do so silently, showing €0 and 0 clients as if they were real figures.
  const [partialFailures, setPartialFailures] = useState<string[]>([]);
  // The salon's figures (Analítica's overview and status counts, the team)
  // are the owner's and admins': the API answers staff with a 403, so they
  // are not asked for, and the page leaves those cards out. Asking anyway
  // showed every professional a "some data could not be loaded" banner.
  const [salonFigures, setSalonFigures] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const failed: string[] = [];
    const manager = isManager(getCurrentUser()?.role);
    setSalonFigures(manager);
    const soft = <T,>(name: string, request: Promise<T>, fallback: T) =>
      request.catch((err) => {
        console.error(`Dashboard: ${name} failed to load:`, err);
        failed.push(name);
        return fallback;
      });
    try {
      const [overview, statusByDays, todayPayments, clients, professionals, home, unread] = await Promise.all([
        manager ? soft("overview", apiClient.getAnalyticsOverview(1), null) : null,
        manager ? soft("statusByDays", apiClient.getAppointmentStatusByDays(14), [] as any[]) : ([] as any[]),
        soft("todayPayments", apiClient.getTodayPayments(), [] as any[]),
        soft("clients", apiClient.getClientsPage({ page: 1, pageSize: 1, status: "active" }), null),
        manager ? soft("professionals", apiClient.getProfessionals(), [] as any[]) : ([] as any[]),
        soft("home", apiClient.getHomeSummary(), null as HomeSummary | null),
        soft("unread", apiClient.getUnreadNotificationCount(), { count: 0 }),
      ]);

      const payments = todayPaymentsFigures((todayPayments ?? []) as TodayPaymentRow[]);

      setData({
        stats: overview?.stats ?? EMPTY.stats,
        dailyMetrics: overview?.dailyMetrics ?? [],
        statusByDays: (statusByDays as AppointmentStatusData[]) ?? [],
        todayPaymentsTotal: payments.totalCents,
        todayPaymentsCount: payments.count,
        activeProfessionals: (professionals as any[]).filter((p) => p.isActive !== false).length,
        totalClients: clients?.total ?? 0,
        today: home?.today ?? "",
        now: home?.now ?? "",
        todayAppointments: home?.todayAppointments ?? [],
        pendingConfirmations: home?.pendingConfirmations ?? EMPTY.pendingConfirmations,
        pendingPayments: home?.pendingPayments ?? EMPTY.pendingPayments,
        unreadNotificationsCount: (unread as any)?.count ?? 0,
      });
      setPartialFailures(failed);
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
      setError(err instanceof Error ? err.message : "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, partialFailures, salonFigures, refresh: fetchData };
}
