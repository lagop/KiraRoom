"use client";

import { useCallback, useEffect, useState } from "react";
import apiClient from "@/lib/api";

export interface DashboardStats {
  totalRevenue: number;
  totalAppointments: number;
  newClients: number;
  avgOrderValue: number;
  revenueChange: number;
  appointmentsChange: number;
  clientsChange: number;
  orderValueChange: number;
}

export interface RevenueDataPoint {
  month: string;
  revenue: number;
}

export interface ServicePopularity {
  name: string;
  count: number;
  percentage: number;
}

export interface AppointmentStatusData {
  name: string;
  count: number;
  color: string;
}

export interface TopService {
  name: string;
  count: number;
  revenue: number;
}

export interface TopProfessional {
  name: string;
  appointments: number;
  revenue: number;
}

export interface DailyMetric {
  date: string;
  appointments: number;
  revenue: number;
}

export interface UpcomingAppointment {
  id: string;
  scheduledDate: string;
  scheduledTime: string;
  status: string;
  paymentStatus?: string;
  totalAmount?: number | null;
  client?:
    | string
    | {
        id: string;
        firstName: string;
        lastName: string;
      };
  professional?:
    | string
    | {
        id: string;
        firstName: string;
        lastName: string;
      };
  service?:
    | string
    | {
        id: string;
        name: string;
      };
}

export interface PendingPaymentAppointment {
  id: string;
  scheduledDate: string;
  scheduledTime: string;
  status: string;
  paymentStatus?: string;
  totalAmount?: number | null;
  amountPaid?: number;
  amountDue?: number;
  client?: {
    id: string;
    firstName: string;
    lastName: string;
  };
  professional?: {
    id: string;
    firstName: string;
    lastName: string;
  };
  service?: {
    id: string;
    name: string;
  };
}

export interface TodayPayment {
  id: string;
  amount: number;
  status: string;
  createdAt: string;
  client?: {
    id: string;
    firstName: string;
    lastName: string;
  };
}

export interface DashboardData {
  // From /analytics/overview
  stats: DashboardStats;
  revenueData: RevenueDataPoint[];
  servicePopularity: ServicePopularity[];
  appointmentStatus: AppointmentStatusData[];
  topServices: TopService[];
  topProfessionals: TopProfessional[];
  dailyMetrics: DailyMetric[];
  // From /analytics/appointment-status-by-days
  statusByDays: AppointmentStatusData[];
  // From /payments/today + /clients + /professionals
  todayPayments: TodayPayment[];
  todayPaymentsTotal: number;
  activeProfessionals: number;
  totalClients: number;
  // Lists
  upcomingAppointments: UpcomingAppointment[];
  pendingConfirmations: UpcomingAppointment[];
  pendingPayments: PendingPaymentAppointment[];
  // Notifications
  unreadNotificationsCount: number;
}

const EMPTY: DashboardData = {
  stats: {
    totalRevenue: 0,
    totalAppointments: 0,
    newClients: 0,
    avgOrderValue: 0,
    revenueChange: 0,
    appointmentsChange: 0,
    clientsChange: 0,
    orderValueChange: 0,
  },
  revenueData: [],
  servicePopularity: [],
  appointmentStatus: [],
  topServices: [],
  topProfessionals: [],
  dailyMetrics: [],
  statusByDays: [],
  todayPayments: [],
  todayPaymentsTotal: 0,
  activeProfessionals: 0,
  totalClients: 0,
  upcomingAppointments: [],
  pendingConfirmations: [],
  pendingPayments: [],
  unreadNotificationsCount: 0,
};

/**
 * Fetches every piece of data the dashboard overview needs.
 *
 * Uses the dedicated analytics endpoints (`getAnalyticsOverview`,
 * `getAppointmentStatusByDays`) instead of pulling the entire
 * `clients` and `appointments` collections and aggregating in the
 * browser, which is what the previous implementation did.
 *
 * Also fetches supporting widgets: today's payments, pending
 * payments, upcoming appointments, unread notifications.
 */
export function useDashboardData() {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        overview,
        statusByDays,
        todayPayments,
        clients,
        professionals,
        upcoming,
        pendingPayments,
        unread,
      ] = await Promise.all([
        apiClient.getAnalyticsOverview(1).catch(() => null),
        apiClient.getAppointmentStatusByDays(14).catch(() => []),
        apiClient.getTodayPayments().catch(() => []),
        apiClient.getClients().catch(() => []),
        apiClient.getProfessionals().catch(() => []),
        apiClient
          .getAppointments({
            status: "pending",
          })
          .catch(() => []),
        apiClient.getPendingPaymentAppointments().catch(() => []),
        apiClient.getUnreadNotificationCount().catch(() => ({ count: 0 })),
      ]);

      const todayPaymentsTotal = (todayPayments as TodayPayment[]).reduce(
        (sum, p) => sum + Number((p as any).amount ?? 0),
        0,
      );

      const pendingConfirmations = (
        upcoming as UpcomingAppointment[]
      ).filter((a) => a.status === "pending").slice(0, 5);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const todaysUpcoming = (
        upcoming as UpcomingAppointment[]
      ).filter((a) => {
        const aptDate = new Date(a.scheduledDate);
        return (
          aptDate >= today && (a.status === "pending" || a.status === "confirmed")
        );
      })
        .sort(
          (a, b) =>
            new Date(a.scheduledDate).getTime() -
            new Date(b.scheduledDate).getTime(),
        )
        .slice(0, 5);

      setData({
        stats: overview?.stats ?? EMPTY.stats,
        revenueData: overview?.revenueData ?? [],
        servicePopularity: overview?.servicePopularity ?? [],
        appointmentStatus: overview?.appointmentStatus ?? [],
        topServices: overview?.topServices ?? [],
        topProfessionals: overview?.topProfessionals ?? [],
        dailyMetrics: overview?.dailyMetrics ?? [],
        statusByDays: (statusByDays as AppointmentStatusData[]) ?? [],
        todayPayments: (todayPayments as TodayPayment[]) ?? [],
        todayPaymentsTotal,
        activeProfessionals: (professionals as any[]).filter(
          (p) => p.isActive !== false,
        ).length,
        totalClients: (clients as any[]).length,
        upcomingAppointments: todaysUpcoming,
        pendingConfirmations,
        pendingPayments: (pendingPayments as PendingPaymentAppointment[]).slice(
          0,
          5,
        ),
        unreadNotificationsCount: (unread as any)?.count ?? 0,
      });
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
      setError(
        err instanceof Error ? err.message : "Failed to load dashboard data",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}
