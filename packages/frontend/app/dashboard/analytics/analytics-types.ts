/**
 * The shapes the analytics page reads from the API (backend
 * analytics.service.ts, typed in lib/api.ts). Money is in cents everywhere
 * (lib/analytics-format).
 */

import type {
  AnalyticsAppointmentRates,
  AnalyticsAppointmentRatesResponse,
  AnalyticsClientInsights,
  AnalyticsOccupancy,
  AnalyticsOverviewResponse,
  AnalyticsProfessionalRow,
  AnalyticsStats,
  AnalyticsTillSales,
  SalonLocation,
} from "@/lib/api";
import type { AnalyticsRange } from "@/lib/analytics-format";
import type { DailyPoint, EvolutionRow, StatusCount } from "@/lib/analytics-charts";

export type { AnalyticsRange, DailyPoint, EvolutionRow, StatusCount };

export type DashboardStats = AnalyticsStats;
export type AppointmentRates = AnalyticsAppointmentRates;
export type MonthlyRates = NonNullable<AnalyticsAppointmentRatesResponse["byMonth"]>[number];
export type TillSales = AnalyticsTillSales;
export type Occupancy = AnalyticsOccupancy;
export type AnalyticsOverview = AnalyticsOverviewResponse;
export type ProfessionalPerformance = AnalyticsProfessionalRow;
export type ClientInsights = AnalyticsClientInsights;
export type { SalonLocation };

export type RevenueDataPoint = AnalyticsOverviewResponse["revenueData"][number];
export type ServicePopularity = AnalyticsOverviewResponse["servicePopularity"][number];
/** Bookings and paid revenue per service, by revenue. */
export type TopService = AnalyticsOverviewResponse["topServices"][number];

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
