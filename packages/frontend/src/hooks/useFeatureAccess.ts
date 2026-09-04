"use client";

import { useEffect, useState } from "react";
import apiClient, { getToken, decodeJwtToken } from "../../lib/api";
import {
  FeatureKey,
  PlanId,
  isFeatureEnabledForPlan,
  normalizePlan,
} from "../lib/plans";

interface TenantContext {
  plan: PlanId;
  inTrial: boolean;
  trialEnd: string | null;
  subscriptionStatus: string;
  cancelledAt: string | null;
  readOnlyUntil: string | null;
  addons: Record<string, any>;
  loading: boolean;
}

const EMPTY: TenantContext = {
  plan: "esencial",
  inTrial: false,
  trialEnd: null,
  subscriptionStatus: "cancelled",
  cancelledAt: null,
  readOnlyUntil: null,
  addons: {},
  loading: true,
};

/**
 * Build a TenantContext from the current JWT (cheap) and refresh from the
 * server when a token is present. Falls back to "esencial / cancelled" so
 * we never expose paid features by accident.
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
        const sub = await apiClient.getCurrentSubscription();
        if (cancelled || !sub) {
          setCtx((prev) => ({ ...prev, loading: false }));
          return;
        }
        const now = Date.now();
        const trialEnd = sub.trialEnd
          ? new Date(sub.trialEnd).getTime()
          : null;
        const inTrial =
          sub.subscriptionStatus === "trialing" &&
          trialEnd !== null &&
          trialEnd > now;

        setCtx({
          plan: normalizePlan(sub.plan),
          inTrial,
          trialEnd: sub.trialEnd ?? null,
          subscriptionStatus: sub.subscriptionStatus ?? sub.status ?? 'cancelled',
          cancelledAt: sub.cancelledAt ?? null,
          readOnlyUntil: sub.readOnlyUntil ?? null,
          addons: (sub.addons as Record<string, any>) ?? {},
          loading: false,
        });
      } catch {
        setCtx((prev) => ({ ...prev, loading: false }));
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

  return {
    plan: normalizePlan(decoded.plan),
    inTrial,
    trialEnd: decoded.trialEnd ?? null,
    subscriptionStatus: decoded.subscriptionStatus ?? "cancelled",
    cancelledAt: null,
    readOnlyUntil: null,
    addons: {},
    loading: false,
  };
}

export interface FeatureAccess {
  enabled: boolean;
  loading: boolean;
  plan: PlanId;
  inTrial: boolean;
  effectivePlan: PlanId;
}

/**
 * Single hook the UI uses to ask "is feature X enabled for me?".
 * - cancelled tenants: never enabled (read-only mode)
 * - trialing tenants: behave as `pro` for 14 days
 * - `web_domain`: lives in Tenant.addons, not the plan matrix
 */
export function useFeatureAccess(key: FeatureKey): FeatureAccess {
  const ctx = useTenantContext();

  if (ctx.loading) {
    return {
      enabled: false,
      loading: true,
      plan: ctx.plan,
      inTrial: ctx.inTrial,
      effectivePlan: ctx.inTrial ? "pro" : ctx.plan,
    };
  }

  if (ctx.subscriptionStatus === "cancelled") {
    return {
      enabled: false,
      loading: false,
      plan: ctx.plan,
      inTrial: ctx.inTrial,
      effectivePlan: ctx.inTrial ? "pro" : ctx.plan,
    };
  }

  if (key === "web_domain") {
    return {
      enabled: !!ctx.addons?.web_domain?.enabled,
      loading: false,
      plan: ctx.plan,
      inTrial: ctx.inTrial,
      effectivePlan: ctx.inTrial ? "pro" : ctx.plan,
    };
  }

  const effectivePlan: PlanId = ctx.inTrial ? "pro" : ctx.plan;
  return {
    enabled: isFeatureEnabledForPlan(effectivePlan, key),
    loading: false,
    plan: ctx.plan,
    inTrial: ctx.inTrial,
    effectivePlan,
  };
}
