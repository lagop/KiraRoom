"use client";

import { useEffect, useState } from "react";
import apiClient, { getToken, decodeJwtToken } from "../../lib/api";
import {
  featureEnabled,
  isReadOnlyStatus,
  planContextFromServer,
  type PlanContextView,
} from "../../lib/plan-context";
import { FeatureKey, PlanId, normalizePlan } from "../lib/plans";

interface TenantContext extends PlanContextView {
  loading: boolean;
  /**
   * True once the status comes from the server. Until then it is read from
   * the token, whose fallback is "cancelled": anything that warns about the
   * subscription waits for this, or a paying salon sees the warning flash.
   */
  confirmed: boolean;
}

const EMPTY: TenantContext = {
  plan: "esencial",
  effectivePlan: "esencial",
  inTrial: false,
  trialEnd: null,
  subscriptionStatus: "cancelled",
  subscribed: false,
  cancelledAt: null,
  readOnlyUntil: null,
  addOnFeatures: [],
  loading: true,
  confirmed: false,
};

/**
 * Build a TenantContext from the current JWT (cheap) and refresh from the
 * server when a token is present. Falls back to "esencial / cancelled" so
 * we never expose paid features by accident.
 *
 * The server's answer is GET /payments/subscription/context, open to the
 * whole team (B2): admins and professionals used to get a 403 from the
 * owner's billing route and stayed on the fallback.
 */
export function useTenantContext(): TenantContext {
  const [ctx, setCtx] = useState<TenantContext>(() => readFromJwt());

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const token = getToken();
      if (!token) {
        setCtx({ ...EMPTY, loading: false });
        return;
      }
      try {
        const sub = await apiClient.getSubscriptionContext();
        if (cancelled) return;
        if (!sub) {
          setCtx((prev) => ({ ...prev, loading: false }));
          return;
        }
        setCtx({ ...planContextFromServer(sub), loading: false, confirmed: true });
      } catch {
        if (!cancelled) setCtx((prev) => ({ ...prev, loading: false }));
      }
    };

    refresh();
    return () => {
      cancelled = true;
    };
  }, []);

  return ctx;
}

function readFromJwt(): TenantContext {
  if (typeof window === "undefined") {
    return { ...EMPTY, loading: true };
  }
  const token = getToken();
  if (!token) return { ...EMPTY, loading: false };
  const decoded = decodeJwtToken(token) || {};
  const now = Date.now();
  const trialEndMs = decoded.trialEnd
    ? new Date(decoded.trialEnd).getTime()
    : null;
  const inTrial =
    decoded.subscriptionStatus === "trialing" &&
    trialEndMs !== null &&
    trialEndMs > now;

  const plan = normalizePlan(decoded.plan);
  return {
    plan,
    effectivePlan: inTrial ? "pro" : plan,
    inTrial,
    trialEnd: decoded.trialEnd ?? null,
    subscriptionStatus: decoded.subscriptionStatus ?? "cancelled",
    subscribed: false,
    cancelledAt: null,
    readOnlyUntil: null,
    addOnFeatures: [],
    loading: false,
    confirmed: false,
  };
}

export interface FeatureAccess {
  enabled: boolean;
  loading: boolean;
  plan: PlanId;
  inTrial: boolean;
  effectivePlan: PlanId;
  /**
   * Confirmed by the server as read-only (cancelled or suspended): a locked
   * feature is then explained as read-only, not as an upgrade (B13).
   */
  readOnly: boolean;
  subscriptionStatus: string;
  readOnlyUntil: string | null;
}

/**
 * Single hook the UI uses to ask "is feature X enabled for me?".
 * - cancelled tenants: never enabled (read-only mode)
 * - trialing tenants: behave as `pro` until the trial ends
 * - add-ons unlock their features on top of the plan
 */
export function useFeatureAccess(key: FeatureKey): FeatureAccess {
  const ctx = useTenantContext();
  const base = {
    plan: ctx.plan,
    inTrial: ctx.inTrial,
    effectivePlan: ctx.effectivePlan,
    readOnly: ctx.confirmed && isReadOnlyStatus(ctx.subscriptionStatus),
    subscriptionStatus: ctx.subscriptionStatus,
    readOnlyUntil: ctx.readOnlyUntil,
  };

  if (ctx.loading) {
    return { ...base, enabled: false, loading: true };
  }
  return { ...base, enabled: featureEnabled(ctx, key), loading: false };
}
