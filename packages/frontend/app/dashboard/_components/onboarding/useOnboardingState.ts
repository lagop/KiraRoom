"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import apiClient, { OnboardingState } from "@/lib/api";

export const ONBOARDING_QUERY_KEY = ["onboarding", "state"] as const;
const QUERY_KEY = ONBOARDING_QUERY_KEY;

/**
 * GET /onboarding/state, without polling: it used to refetch every 30 s
 * (15 s under the overlay) in every tab for ever, and each request runs
 * every detector on the server. It is refreshed instead when the user moves
 * to another page (OnboardingHost), comes back to the tab, or saves a step
 * (the mutations below and the overlay's onDone), and not at all once
 * onboarding is settled (onboardingSettled).
 */
export function useOnboardingState(options?: { enabled?: boolean }) {
  return useQuery<OnboardingState>({
    enabled: options?.enabled ?? true,
    queryKey: QUERY_KEY,
    queryFn: () => apiClient.getOnboardingState(),
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
