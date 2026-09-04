"use client";

import { useOnboardingState } from "./useOnboardingState";
import { OnboardingLinearOverlay } from "./OnboardingLinearOverlay";
import { OnboardingChecklistOrLoader } from "./OnboardingChecklist";

/**
 * Single host for both onboarding surfaces. Mounted in the dashboard layout.
 * Renders the linear overlay if the tenant hasn't finished the required
 * steps, and the checklist drawer otherwise.
 */
export function OnboardingHost() {
  const { data, isLoading } = useOnboardingState({ refetchInterval: 30_000 });
  if (isLoading || !data) return null;

  const linearDefs = data.defs.filter((d) => d.group === "linear_required");
  const showLinear = !data.finishedAt && data.currentStep < linearDefs.length;

  return (
    <>
      {showLinear && <OnboardingLinearOverlay />}
      <OnboardingChecklistOrLoader />
    </>
  );
}