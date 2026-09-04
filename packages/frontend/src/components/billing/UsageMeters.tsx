"use client";

import { useEffect, useState } from "react";
import apiClient from "../../../lib/api";

interface UsageBucket {
  current: number;
  limit: number;
  unlimited: boolean;
}

interface UsageResponse {
  plan: string;
  inTrial: boolean;
  trialEnd: string | null;
  subscriptionStatus: string;
  maxLocations?: number;
  usage: {
    clients: UsageBucket;
    professionals: UsageBucket;
    appointments: UsageBucket;
  };
}

interface UsageMetersProps {
  refreshKey?: number;
}

/**
 * Small progress bars (clients / professionals / appointments) sourced from
 * `GET /payments/subscription/usage`. Used on the billing page and as a
 * compact summary on the dashboard.
 */
export function UsageMeters({ refreshKey = 0 }: UsageMetersProps) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient
      .getSubscriptionUsage()
      .then((res: any) => {
        if (cancelled) return;
        // Backend shape changed (uses clients/professionals/appointments
        // instead of staffCount/clientCount/...). Normalize here.
        const u = res?.usage ?? {};
        const normalized: UsageResponse = {
          plan: res?.plan ?? "esencial",
          inTrial: !!res?.inTrial,
          trialEnd: res?.trialEnd ?? null,
          subscriptionStatus: res?.subscriptionStatus ?? "cancelled",
          maxLocations: res?.maxLocations,
          usage: {
            clients: u.clients ?? { current: 0, limit: 0, unlimited: false },
            professionals: u.professionals ?? {
              current: 0,
              limit: 0,
              unlimited: false,
            },
            appointments: u.appointments ?? {
              current: 0,
              limit: 0,
              unlimited: false,
            },
          },
        };
        setData(normalized);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-lg bg-gray-100"
          />
        ))}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Meter
        label="Clientas"
        bucket={data.usage.clients}
        cap="clientes"
      />
      <Meter
        label="Profesionales"
        bucket={data.usage.professionals}
        cap="profesionales"
      />
      <Meter
        label="Citas este mes"
        bucket={data.usage.appointments}
        cap="citas"
      />
    </div>
  );
}

function Meter({
  label,
  bucket,
  cap,
}: {
  label: string;
  bucket: UsageBucket;
  cap: string;
}) {
  const pct = bucket.unlimited
    ? 0
    : Math.min(100, bucket.limit > 0 ? (bucket.current / bucket.limit) * 100 : 0);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        {bucket.unlimited ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
            Ilimitado
          </span>
        ) : (
          <span className="text-xs text-gray-500">
            {bucket.current} / {bucket.limit} {cap}
          </span>
        )}
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full ${
            pct >= 90
              ? "bg-red-500"
              : pct >= 70
                ? "bg-amber-500"
                : "bg-violet-500"
          }`}
          style={{ width: bucket.unlimited ? "100%" : `${pct}%` }}
        />
      </div>
    </div>
  );
}
