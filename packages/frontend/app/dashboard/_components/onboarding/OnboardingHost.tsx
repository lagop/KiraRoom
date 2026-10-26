"use client";

import { useEffect, useState } from "react";
import { getCurrentUser } from "@/lib/utils";
import { useOnboardingState } from "./useOnboardingState";
import { OnboardingLinearOverlay } from "./OnboardingLinearOverlay";
import { OnboardingChecklistOrLoader } from "./OnboardingChecklist";

/**
 * Single host for both onboarding surfaces. Mounted in the dashboard layout.
 * Renders the linear overlay if the tenant hasn't finished the required
 * steps, and the checklist drawer otherwise.
 *
 * Only for those who set the salon up (owners, managers). A professional got
 * the full-screen "Vamos a configurar tu salón" over their agenda while the
 * owner had not finished it, with steps they are not allowed to save.
 */
export function OnboardingHost() {
  // Read after mount: the role comes from localStorage, absent on the server.
  const [setsUpSalon, setSetsUpSalon] = useState<boolean | null>(null);
  useEffect(() => {
    setSetsUpSalon(getCurrentUser()?.role !== "staff");
  }, []);

  const { data, isLoading } = useOnboardingState({ refetchInterval: 30_000, enabled: setsUpSalon === true });
  if (!setsUpSalon || isLoading || !data) return null;

  const linearDefs = data.defs.filter((d) => d.group === "linear_required");
  const showLinear = !data.finishedAt && data.currentStep < linearDefs.length;

  return (
    <>
      {showLinear && <OnboardingLinearOverlay />}
      <OnboardingChecklistOrLoader />
    </>
  );
}
