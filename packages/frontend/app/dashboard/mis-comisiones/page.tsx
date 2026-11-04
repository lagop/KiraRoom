"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import apiClient, { type CommissionPayout } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { errorMessage, isPlanBlocked } from "@/lib/email-campaigns";
import { formatCommissionCents, formatCommissionDay, formatPercent } from "@/lib/commissions-format";
import { AlertCircle, CheckCircle, Clock, Lock, TrendingUp } from "lucide-react";

interface MyEntry {
  id: string;
  date: string;
  clientName: string;
  serviceName: string;
  amount: number;
  commissionRate: number;
  commissionAmount: number;
  paid: boolean;
  source?: "appointment" | "sale" | "refund_adjustment";
  kind?: "service" | "product";
  description?: string;
}

interface MyCommissions {
  /** null: the user has no professional profile. */
  professionalId: string | null;
  pendingCommission: number;
  paidCommission: number;
  pendingUpTo?: string;
  appointments: MyEntry[];
  payouts: CommissionPayout[];
}

/**
 * "Mis comisiones": a professional's own commissions, read-only -- what is
 * pending up to today (refund adjustments included) and what the salon has
 * paid them, in euros. GET /commissions/me, the same shape as the salon's
 * summary of one professional.
 */
export default function MyCommissionsPage() {
  const t = useTranslations();
  const [data, setData] = useState<MyCommissions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planBlocked, setPlanBlocked] = useState(false);

  const load = async () => {
    try {
      setError(null);
      setData(await apiClient.getMyCommissions());
    } catch (e) {
      if (isPlanBlocked(e)) setPlanBlocked(true);
      else setError(errorMessage(e, t("commissions.load_error")));
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = (e: MyEntry) =>
    e.source === "refund_adjustment"
      ? `${t("commissions.refund_adjustment")}${e.description ? `: ${e.description}` : ""}`
      : e.kind === "product"
        ? `${t("commissions.product")}: ${e.serviceName}`
        : e.serviceName;

  const header = (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">{t("commissions.my_title")}</h1>
      <p className="text-gray-500 mt-1">{t("commissions.my_subtitle")}</p>
    </div>
  );

  if (planBlocked) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        {header}
        <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-6">
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
          <p className="text-sm text-gray-700">{t("commissions.plan_blocked_title")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {header}

      {error && (
        <div role="alert" className="rounded-lg bg-white p-6 text-center shadow">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
          <p className="mb-4 text-sm text-gray-600">{error}</p>
          <button
            onClick={load}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t("commissions.retry")}
          </button>
        </div>
      )}

      {!error && !data && (
        <div className="flex h-32 items-center justify-center" aria-busy="true">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600"></div>
        </div>
      )}

      {data && data.professionalId === null && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
          {t("commissions.my_no_profile")}{" "}
          <Link href="/dashboard" className="font-medium underline">
            {t("nav.dashboard")}
          </Link>
        </div>
      )}

      {data && data.professionalId !== null && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg bg-white p-6 shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">{t("commissions.pending_commission")}</p>
                  <p className="text-2xl font-bold text-yellow-600">{formatCommissionCents(data.pendingCommission)}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {t("commissions.my_pending_hint", { date: formatCommissionDay(data.pendingUpTo ?? null) })}
                  </p>
                </div>
                <div className="rounded-full bg-yellow-100 p-3">
                  <Clock className="h-6 w-6 text-yellow-600" />
                </div>
              </div>
            </div>
            <div className="rounded-lg bg-white p-6 shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">{t("commissions.paid_this_month")}</p>
                  <p className="text-2xl font-bold text-green-600">{formatCommissionCents(data.paidCommission)}</p>
                </div>
                <div className="rounded-full bg-blue-100 p-3">
                  <TrendingUp className="h-6 w-6 text-blue-600" />
                </div>
              </div>
            </div>
          </div>

          <section className="rounded-lg bg-white shadow">
            <h2 className="border-b border-gray-200 px-6 py-4 font-semibold text-gray-900">
              {t("commissions.pending")}
            </h2>
            {data.appointments.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-gray-500">{t("commissions.my_empty")}</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {data.appointments.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="text-gray-500">{formatCommissionDay(e.date)}</span> · {e.clientName} · {name(e)}
                    </span>
                    <span className="flex items-center gap-3 whitespace-nowrap">
                      {e.source !== "refund_adjustment" && (
                        <span className="text-gray-500">
                          {formatCommissionCents(e.amount)} × {formatPercent(e.commissionRate)}
                        </span>
                      )}
                      <span className="font-medium text-gray-900">{formatCommissionCents(e.commissionAmount)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg bg-white shadow">
            <h2 className="border-b border-gray-200 px-6 py-4 font-semibold text-gray-900">
              {t("commissions.my_payouts")}
            </h2>
            {data.payouts.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-gray-500">{t("commissions.payouts_empty")}</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {data.payouts.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                    <span>
                      {formatCommissionDay(p.createdAt)} · {t("commissions.payout_up_to")}{" "}
                      {formatCommissionDay(p.upTo)}
                    </span>
                    <span className="flex items-center gap-2 font-medium text-gray-900">
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      {formatCommissionCents(p.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
