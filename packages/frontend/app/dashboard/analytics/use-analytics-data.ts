"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import apiClient from "@/lib/api";
import { createLatestGuard } from "@/lib/analytics-charts";
import { evolutionMonthsFor } from "@/lib/analytics-format";
import type {
  AnalyticsFeatureFlags,
  AnalyticsOverview,
  AnalyticsRange,
  ClientInsights,
  EvolutionRow,
  MonthlyRates,
  ProfessionalPerformance,
  ProfessionalRange,
  SalonLocation,
  StatusCount,
} from "./analytics-types";

export interface Resource<T> {
  /** The last good answer; kept while a newer one loads. */
  data: T | null;
  /** The failure of the latest request (translated by the page). */
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads `fetcher` whenever `key` changes (null: not now). Only the latest
 * request's answer is applied, so a slow answer for an old period cannot
 * overwrite a newer one, and the previous data stays on screen while the
 * next one loads. A failure clears the data: an error is never shown next to
 * figures from another period.
 */
export function useAsyncResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  label: string,
): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: false,
  });
  // The fetcher closes over the current inputs; the key says when they changed.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [guard] = useState(createLatestGuard);

  const load = useCallback(() => {
    if (key === null) {
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return;
    }
    const id = guard.begin();
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcherRef.current().then(
      (data) => {
        if (guard.isLatest(id)) setState({ data, error: null, loading: false });
      },
      (error) => {
        if (!guard.isLatest(id)) return;
        console.error(`Failed to load ${label}:`, error);
        setState({ data: null, error, loading: false });
      },
    );
  }, [key, guard, label]);

  useEffect(() => {
    load();
    return guard.cancel;
  }, [load, guard]);

  return { ...state, reload: load };
}

export interface AnalyticsInputs {
  /** False until the role is known to be owner or admin: nothing is requested before. */
  enabled: boolean;
  range: AnalyticsRange;
  professionalRange: ProfessionalRange;
  /** Empresa's location filter; null for the whole salon. */
  locationId: string | null;
  /** Empresa: the salon's locations are loaded for the filter. */
  locationsEnabled: boolean;
  /** Tabs opened at least once: theirs are the only advanced requests made. */
  opened: { professionals: boolean; clients: boolean };
}

/**
 * Every request of the analytics page, each keyed by the inputs it really
 * depends on: the period does not refetch the plan or the Profesionales
 * tab, and switching tabs back and forth does not refetch at all. The
 * location filter applies to every figure.
 */
export function useAnalyticsData({
  enabled,
  range,
  professionalRange,
  locationId,
  locationsEnabled,
  opened,
}: AnalyticsInputs) {
  const features = useAsyncResource<AnalyticsFeatureFlags>(
    enabled ? "features" : null,
    () => apiClient.getAnalyticsFeatures(),
    "features",
  );
  const maxMonths = features.data?.maxMonths ?? 3;
  const isAdvanced = !!features.data?.hasAdvancedAnalytics;
  const loc = locationId ?? "all";

  const locations = useAsyncResource<SalonLocation[]>(
    enabled && locationsEnabled ? "locations" : null,
    () => apiClient.getLocations(),
    "locations",
  );

  const overview = useAsyncResource<AnalyticsOverview>(
    enabled ? `overview:${range}:${loc}` : null,
    () => apiClient.getAnalyticsOverview({ range, locationId }),
    "analytics",
  );

  // The evolution follows the selected period, cut to the plan (3 months
  // for the short presets: one bar shows no trend).
  const evolutionMonths = evolutionMonthsFor(range, maxMonths);
  const evolutionKey = enabled && features.data ? `${evolutionMonths}:${loc}` : null;
  const evolution = useAsyncResource<EvolutionRow[]>(
    evolutionKey && `evolution:${evolutionKey}`,
    () => apiClient.getAppointmentStatusesEvolution(evolutionMonths, locationId),
    "statuses evolution",
  );
  // The percentage chart reads the API's closing rates per month: the
  // insights' definition (closed appointments up to yesterday).
  const monthlyRates = useAsyncResource<MonthlyRates[]>(
    evolutionKey && `rates:${evolutionKey}`,
    async () => (await apiClient.getAppointmentRates({ months: evolutionMonths, locationId })).byMonth ?? [],
    "monthly rates",
  );

  // Two calls: the endpoint returns counts only, so the last 7 days cannot
  // be cut out of the last 14 here.
  const statusByDays = useAsyncResource<{ last7: StatusCount[]; last14: StatusCount[] }>(
    enabled ? `status-by-days:${loc}` : null,
    async () => {
      const [last7, last14] = await Promise.all([
        apiClient.getAppointmentStatusByDays(7, locationId),
        apiClient.getAppointmentStatusByDays(14, locationId),
      ]);
      return { last7, last14 };
    },
    "status by days",
  );

  const professionals = useAsyncResource<ProfessionalPerformance[]>(
    enabled && isAdvanced && opened.professionals ? `professionals:${professionalRange}:${loc}` : null,
    () => apiClient.getProfessionalPerformance(professionalRange, locationId),
    "professionals data",
  );

  const clients = useAsyncResource<ClientInsights>(
    enabled && isAdvanced && opened.clients ? `clients:${range}:${loc}` : null,
    () => apiClient.getClientInsights({ range, locationId }),
    "clients data",
  );

  return {
    features,
    maxMonths,
    isAdvanced,
    locations,
    overview,
    evolution,
    monthlyRates,
    statusByDays,
    professionals,
    clients,
  };
}
