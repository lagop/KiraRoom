"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Crown, Loader2, MapPin } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useFeatureAccess } from "@/hooks/useFeatureAccess";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import { clampRange, formatPeriod, type AnalyticsRange } from "@/lib/analytics-format";
import type { ProfessionalRange, Tab, Translate } from "./analytics-types";
import { useAnalyticsData, type Resource } from "./use-analytics-data";
import { AdvancedAnalyticsGate } from "./components/AdvancedAnalyticsGate";
import { AnalyticsTabs, panelId, tabId } from "./components/AnalyticsTabs";
import { ClientsTab } from "./components/ClientsTab";
import { DailyChart } from "./components/DailyChart";
import { KeyInsights } from "./components/KeyInsights";
import { PeriodSelector } from "./components/PeriodSelector";
import { ProfessionalsTab } from "./components/ProfessionalsTab";
import { RevenueChart } from "./components/RevenueChart";
import { ServicePopularityCard, TopServicesCard } from "./components/ServiceCharts";
import { StatsGrid, TillSalesRow } from "./components/StatsGrid";
import { ExportMenu, LocationSelector } from "./components/Toolbar";
import { StatusEvolution, StatusPercentage } from "./components/StatusEvolution";
import { AppointmentStatusCard } from "./components/StatusDonut";
import { InlineError, InlineSpinner } from "./components/ui";

/**
 * What to tell the owner when a request fails. ApiError carries the HTTP
 * status, the server's code and its (Spanish) message.
 */
function errorText(err: unknown, t: Translate): string {
  if (err instanceof ApiError) {
    if (err.status === 403 && err.code === "FEATURE_NOT_IN_PLAN") {
      return t("analytics.upgrade_required_message");
    }
    // 4xx messages are written for the salon (e.g. "Tu cuenta no está
    // vinculada..."); 5xx ones are not.
    if (err.status >= 400 && err.status < 500 && err.message) return err.message;
  }
  return t("analytics.failed_to_load_data");
}

export default function AnalyticsPage() {
  const t = useTranslations();
  const router = useRouter();

  // Analítica is for whoever runs the salon. Read the role after mount (the
  // server has no token) and send anyone else to the dashboard before any
  // request is made.
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);
  useEffect(() => {
    if (role !== undefined && !isManager(role)) router.replace("/dashboard");
  }, [role, router]);

  const [range, setRange] = useState<AnalyticsRange>("3_months");
  // Empresa: the whole salon (null) or one of its locations.
  const [locationId, setLocationId] = useState<string | null>(null);
  const [professionalRange, setProfessionalRange] = useState<ProfessionalRange>("this_month");
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  // The advanced tabs load the first time they are opened, then keep their data.
  const [opened, setOpened] = useState({ professionals: false, clients: false });
  const openTab = (tab: Tab) => {
    setActiveTab(tab);
    if (tab !== "overview") setOpened((o) => (o[tab] ? o : { ...o, [tab]: true }));
  };

  // Empresa: a location filter here, and Multi-local's consolidated report.
  const multiLocation = useFeatureAccess("consolidated_reports").enabled;

  const { features, maxMonths, isAdvanced, locations, overview, evolution, monthlyRates, statusByDays, professionals, clients } =
    useAnalyticsData({
      enabled: manager,
      range,
      professionalRange,
      locationId: multiLocation ? locationId : null,
      locationsEnabled: multiLocation,
      opened,
    });

  // A plan with fewer months than the selection (e.g. after a downgrade).
  const planMonths = features.data?.maxMonths;
  useEffect(() => {
    if (planMonths && clampRange(range, planMonths) !== range) setRange(clampRange(range, planMonths));
  }, [planMonths, range]);

  const errorOf = (r: Resource<unknown>) => (r.error ? errorText(r.error, t) : null);

  const data = overview.data;
  if (!manager || (!data && !overview.error)) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" aria-hidden />
      </div>
    );
  }

  // The Profesionales tab has its own range; the page's period does not
  // apply to it, so its selector and period line are hidden there.
  const showPagePeriod = activeTab !== "professionals";
  const refreshingOverview = overview.loading && !!data;
  const stats = data?.stats;
  const last7 = statusByDays.data?.last7 ?? [];
  const last14 = statusByDays.data?.last14 ?? [];
  const evolutionRows = evolution.data ?? [];
  const evolutionPending =
    !evolution.data && !evolution.error && (evolution.loading || (!features.data && !features.error));
  const evolutionRefreshing = evolution.loading && !!evolution.data;
  const evolutionError = errorOf(evolution);
  const ratesPending = !monthlyRates.data && !monthlyRates.error && (monthlyRates.loading || !features.data);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate" suppressHydrationWarning>
            {t("analytics.title")}
          </h1>
          <p className="text-gray-500 mt-1" suppressHydrationWarning>
            {t("analytics.description")}
          </p>
          {showPagePeriod && data?.period && (
            <p className="text-xs text-gray-400 mt-1 flex items-center gap-2">
              {t("analytics.period_label")}: {formatPeriod(data.period)}
              {data.location && ` · ${data.location.name}`}
              {refreshingOverview && <InlineSpinner label={t("analytics.updating")} />}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {multiLocation && (
            <LocationSelector t={t} locations={locations.data ?? []} value={locationId} onChange={setLocationId} />
          )}
          {multiLocation && (
            <Link
              href="/dashboard/multi-location"
              className="flex items-center px-4 py-2 text-sm font-medium text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-50"
            >
              <MapPin className="w-4 h-4 mr-2" aria-hidden />
              {t("analytics.view_by_location")}
            </Link>
          )}
          {features.data && !isAdvanced && (
            <Link
              href="/dashboard/billing"
              className="flex items-center px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg hover:from-purple-700 hover:to-indigo-700 transition-all"
            >
              <Crown className="w-4 h-4 mr-2" aria-hidden />
              {t("analytics.upgrade_to_pro")}
            </Link>
          )}
          {showPagePeriod && data?.period && (
            <ExportMenu t={t} period={data.period} filteredByLocation={!!data.location} />
          )}
          {showPagePeriod && (
            <PeriodSelector
              t={t}
              value={range}
              maxMonths={maxMonths}
              showPlanNote={!!features.data}
              onChange={setRange}
            />
          )}
        </div>
      </div>

      {features.error ? (
        <InlineError message={t("analytics.features_error")} retryLabel={t("analytics.retry")} onRetry={features.reload} />
      ) : null}

      {features.data && <AnalyticsTabs t={t} active={activeTab} locked={!isAdvanced} onChange={openTab} />}

      <div
        className="space-y-6"
        {...(features.data
          ? { role: "tabpanel", id: panelId(activeTab), "aria-labelledby": tabId(activeTab) }
          : {})}
      >
        {/* Overview: only the error when it failed, never zeros that look real. */}
        {activeTab === "overview" && !stats && overview.error ? (
          <InlineError
            message={errorText(overview.error, t)}
            retryLabel={t("analytics.retry")}
            onRetry={overview.reload}
          />
        ) : null}

        {activeTab === "overview" && stats && data && (
          <div
            className={`space-y-6 transition-opacity ${refreshingOverview ? "opacity-60" : ""}`}
            aria-busy={refreshingOverview || undefined}
          >
            <StatsGrid t={t} stats={stats} />
            {data.tillSales && (
              <TillSalesRow t={t} stats={stats} tillSales={data.tillSales} byLocation={!!data.location} />
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <RevenueChart t={t} rows={data.revenueData ?? []} isAdvanced={isAdvanced} />
              <DailyChart t={t} days={data.dailyMetrics ?? []} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ServicePopularityCard t={t} rows={data.servicePopularity ?? []} />
              <TopServicesCard t={t} rows={data.topServices ?? []} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <StatusEvolution
                t={t}
                rows={evolutionRows}
                error={evolutionError}
                loading={evolutionPending}
                refreshing={evolutionRefreshing}
                onRetry={evolution.reload}
              />
              <StatusPercentage
                t={t}
                rows={monthlyRates.data ?? []}
                error={errorOf(monthlyRates)}
                loading={ratesPending}
                refreshing={monthlyRates.loading && !!monthlyRates.data}
                onRetry={monthlyRates.reload}
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <AppointmentStatusCard
                t={t}
                last7={last7}
                last14={last14}
                error={errorOf(statusByDays)}
                onRetry={statusByDays.reload}
              />
              <KeyInsights
                t={t}
                rates={data.rates}
                last7={last7}
                last14={last14}
                occupancy={data.occupancy}
                period={data.period}
              />
            </div>
          </div>
        )}

        {activeTab === "professionals" && isAdvanced && (
          <ProfessionalsTab
            t={t}
            rows={professionals.data}
            loading={professionals.loading || (!professionals.data && !professionals.error)}
            error={errorOf(professionals)}
            range={professionalRange}
            maxMonths={maxMonths}
            onRangeChange={setProfessionalRange}
            onRetry={professionals.reload}
          />
        )}

        {activeTab === "clients" && isAdvanced && (
          <ClientsTab
            t={t}
            insights={clients.data}
            loading={clients.loading || (!clients.data && !clients.error)}
            error={errorOf(clients)}
            onRetry={clients.reload}
          />
        )}

        {/* Esencial: the tabs are shown locked, with what it takes to open them. */}
        {features.data && !isAdvanced && activeTab !== "overview" && (
          <AdvancedAnalyticsGate note={t("analytics.locked_tab")} />
        )}
      </div>
    </div>
  );
}
