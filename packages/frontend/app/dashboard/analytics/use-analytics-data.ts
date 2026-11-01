"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import apiClient from "@/lib/api";
import { createLatestGuard } from "@/lib/analytics-charts";
import type {
  AnalyticsFeatureFlags,
  AnalyticsOverview,
  ClientInsights,
  EvolutionRow,
  ProfessionalPerformance,
  ProfessionalRange,
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
  timeRange: number;
  professionalRange: ProfessionalRange;
  /** Tabs opened at least once: theirs are the only advanced requests made. */
  opened: { professionals: boolean; clients: boolean };
}

/**
 * Every request of the analytics page, each keyed by the inputs it really
 * depends on: the period does not refetch the plan or the Profesionales
 * tab, and switching tabs back and forth does not refetch at all.
 */
export function useAnalyticsData({ enabled, timeRange, professionalRange, opened }: AnalyticsInputs) {
  const features = useAsyncResource<AnalyticsFeatureFlags>(
    enabled ? "features" : null,
    () => apiClient.getAnalyticsFeatures(),
    "features",
  );
  const maxMonths = features.data?.maxMonths ?? 3;
  const isAdvanced = !!features.data?.hasAdvancedAnalytics;

  const overview = useAsyncResource<AnalyticsOverview>(
    enabled ? `overview:${timeRange}` : null,
    () => apiClient.getAnalyticsOverview(timeRange),
    "analytics",
  );

  // The evolution follows the selected period (the API cuts it to the plan).
  const evolutionMonths = Math.min(timeRange, maxMonths);
  const evolution = useAsyncResource<EvolutionRow[]>(
    enabled && features.data ? `evolution:${evolutionMonths}` : null,
    () => apiClient.getAppointmentStatusesEvolution(evolutionMonths),
    "statuses evolution",
  );

  // Two calls: the endpoint returns counts only, so the last 7 days cannot
  // be cut out of the last 14 here.
  const statusByDays = useAsyncResource<{ last7: StatusCount[]; last14: StatusCount[] }>(
    enabled ? "status-by-days" : null,
    async () => {
      const [last7, last14] = await Promise.all([
        apiClient.getAppointmentStatusByDays(7),
        apiClient.getAppointmentStatusByDays(14),
      ]);
      return { last7, last14 };
    },
    "status by days",
  );

  const professionals = useAsyncResource<ProfessionalPerformance[]>(
    enabled && isAdvanced && opened.professionals ? `professionals:${professionalRange}` : null,
    () => apiClient.getProfessionalPerformance(professionalRange),
    "professionals data",
  );

  const clients = useAsyncResource<ClientInsights>(
    enabled && isAdvanced && opened.clients ? `clients:${timeRange}` : null,
    () => apiClient.getClientInsights(timeRange),
    "clients data",
  );

  return {
    features,
    maxMonths,
    isAdvanced,
    overview,
    evolution,
    statusByDays,
    professionals,
    clients,
  };
}
