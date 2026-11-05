"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { getCurrentUser } from "@/lib/utils";
import { onboardingSettled, showLinearOverlay } from "@/lib/onboarding-wizard";
import { decodeJwtToken, getToken } from "@/lib/api";
import { readOnlyNotice } from "@/lib/read-only-notice";
import { useTenantContext } from "@/hooks/useFeatureAccess";
import { ONBOARDING_QUERY_KEY, useOnboardingState } from "./useOnboardingState";
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
 *
 * The state is refreshed on each move to another page (a step done on that
 * page shows as done), not on a timer, and no longer once onboarding is
 * settled: wizard finished and checklist closed or empty.
 */
export function OnboardingHost() {
  // Read after mount: the role comes from localStorage, absent on the server.
  const [setsUpSalon, setSetsUpSalon] = useState<boolean | null>(null);
  useEffect(() => {
    setSetsUpSalon(getCurrentUser()?.role !== "staff");
  }, []);

  // Impersonated by KiraRoom staff (the token says so): the overlay hid
  // their "Exit impersonation" banner. Read after mount, as the role.
  const [impersonating, setImpersonating] = useState(false);
  useEffect(() => {
    try {
      const token = getToken();
      const claims = token ? (decodeJwtToken(token) as { impersonatedBy?: string } | null) : null;
      setImpersonating(!!claims?.impersonatedBy);
    } catch {
      setImpersonating(false);
    }
  }, []);
  // Read-only salon (trial over, subscription cancelled or suspended).
  const tenantCtx = useTenantContext();
  const readOnly = readOnlyNotice(tenantCtx) !== null;

  const qc = useQueryClient();
  const { data, isLoading } = useOnboardingState({ enabled: setsUpSalon === true });
  const settled = onboardingSettled(data);

  const pathname = usePathname();
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    if (setsUpSalon && data && !settled) {
      qc.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
    }
  }, [pathname, setsUpSalon, data, settled, qc]);

  if (!setsUpSalon || isLoading || !data) return null;

  const linearDefs = data.defs.filter((d) => d.group === "linear_required");
  // Not while read-only (every save would fail, and the overlay hid the way
  // to Facturación: the read-only banner shows instead) nor while
  // impersonating (O3).
  const showLinear = showLinearOverlay({
    finishedAt: data.finishedAt,
    currentStep: data.currentStep,
    linearSteps: linearDefs.length,
    readOnly,
    impersonating,
  });

  return (
    <>
      {showLinear && <OnboardingLinearOverlay />}
      <OnboardingChecklistOrLoader />
    </>
  );
}
