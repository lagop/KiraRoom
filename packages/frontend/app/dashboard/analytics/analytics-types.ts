/**
 * The shapes the analytics page reads from the API (backend
 * analytics.service.ts). Money is in cents everywhere (lib/analytics-format).
 */

import type { DailyPoint, EvolutionRow, StatusCount } from "@/lib/analytics-charts";

export type { DailyPoint, EvolutionRow, StatusCount };

export interface DashboardStats {
  totalRevenue: number;
  /** Booked in the period, cancelled ones excluded. */
  totalAppointments: number;
  /** The appointments behind totalRevenue and avgOrderValue. */
  paidAppointments?: number;
  newClients: number;
  avgOrderValue: number;
  /** Percent against the previous period; null when it had nothing to compare with. */
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

/** Bookings and paid revenue per service, by revenue. */
export interface TopService {
  name: string;
  count: number;
  revenue: number;
}

export interface Occupancy {
  bookedMinutes: number;
  availableMinutes: number;
  rate: number | null;
  professionalsWithSchedule: number;
}

export interface AnalyticsOverview {
  period?: { start: string; end: string };
  occupancy?: Occupancy;
  stats: DashboardStats;
  revenueData: RevenueDataPoint[];
  servicePopularity: ServicePopularity[];
  topServices?: TopService[];
  dailyMetrics?: DailyPoint[];
}

export interface ProfessionalPerformance {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  profileImage: string | null;
  appointments: number;
  revenue: number;
}

export interface ClientInsights {
  newClients: number;
  clientsServed: number;
  returningClients: number;
  totalAppointments: number;
  retentionRate: number;
}

/** From /analytics/features: the effective plan (a trial counts as Pro). */
export interface AnalyticsFeatureFlags {
  hasAdvancedAnalytics: boolean;
  maxMonths: number;
}

export type Tab = "overview" | "professionals" | "clients";

export type ProfessionalRange =
  | "today"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "3_months"
  | "6_months"
  | "12_months";

export type Translate = (key: string, params?: Record<string, any>) => string;
