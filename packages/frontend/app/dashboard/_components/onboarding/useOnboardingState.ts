"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import apiClient, { OnboardingState } from "@/lib/api";

const QUERY_KEY = ["onboarding", "state"] as const;

export function useOnboardingState(options?: { refetchInterval?: number }) {
  return useQuery<OnboardingState>({
    queryKey: QUERY_KEY,
    queryFn: () => apiClient.getOnboardingState(),
    refetchInterval: options?.refetchInterval ?? 30_000,
    staleTime: 60_000,
  });
}

export function useSkipOnboardingStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => apiClient.skipOnboardingStep(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useDismissOnboardingChecklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.dismissOnboardingChecklist(),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useRestoreOnboardingChecklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.restoreOnboardingChecklist(),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}