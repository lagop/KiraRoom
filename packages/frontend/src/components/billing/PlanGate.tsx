"use client";

import { ReactNode } from "react";
import { useFeatureAccess } from "../../hooks/useFeatureAccess";
import { FeatureKey } from "../../lib/plans";
import { UpgradeCTA } from "./UpgradeCTA";

interface PlanGateProps {
  feature: FeatureKey;
  /** UI shown when the feature is not available. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Conditionally renders children when the current tenant's plan (or trial)
 * includes `feature`. Otherwise renders the upgrade CTA (or a custom
 * fallback).
 */
export function PlanGate({ feature, fallback, children }: PlanGateProps) {
  const { enabled, loading, plan, inTrial } = useFeatureAccess(feature);

  if (loading) {
    // Don't flash upgrade CTA during the first paint
    return <div className="opacity-60 pointer-events-none">{children}</div>;
  }

  if (enabled) {
    return <>{children}</>;
  }

  if (fallback !== undefined) {
    return <>{fallback}</>;
  }

  return <UpgradeCTA feature={feature} plan={plan} inTrial={inTrial} />;
}
