"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, CreditCard, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import apiClient, { ConnectStatus } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import {
  connectAction,
  connectActionKey,
  connectReturnKind,
  connectStateClass,
  connectStateKey,
  requirementGroups,
  safeConnectUrl,
} from "@/lib/online-payments";

/**
 * The salon's own Stripe account for online payments (señal / pago anticipado),
 * connected through KiraRoom. The page creates nothing itself: "Conectar" asks
 * the server for Stripe's own sign-up form and sends the salon there; Stripe
 * brings it back with ?connect=return (status is read again) or
 * ?connect=refresh (the link expired: a fresh one is opened).
 */
function CobrosOnlineContent() {
  const t = useTranslations();
  const { toast } = useToast();
  const qc = useQueryClient();
  const search = useSearchParams();
  const [working, setWorking] = useState(false);
  const handled = useRef(false);

  const status = useQuery<ConnectStatus>({
    queryKey: ["connect", "status"],
    queryFn: () => apiClient.getConnectStatus(),
  });

  async function openStripe() {
    setWorking(true);
    try {
      const { url } = await apiClient.startConnectOnboarding();
      const safe = safeConnectUrl(url);
      if (!safe) throw new Error(t("onlinePayments.start_error"));
      window.location.assign(safe);
    } catch (err) {
      setWorking(false);
      toast({
        title: t("onlinePayments.start_error"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  }

  async function setExempt(value: boolean) {
    setWorking(true);
    try {
      qc.setQueryData(["connect", "status"], await apiClient.updateConnectSettings({ depositExemptReturning: value }));
    } catch (err) {
      toast({
        title: t("onlinePayments.rules_error"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  }

  async function refresh() {
    setWorking(true);
    try {
      qc.setQueryData(["connect", "status"], await apiClient.refreshConnectStatus());
    } catch (err) {
      toast({
        title: t("onlinePayments.load_error"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  }

  // Back from Stripe: read the new status, or open a fresh link if the old one expired.
  useEffect(() => {
    if (handled.current) return;
    const kind = connectReturnKind(search.toString());
    if (!kind) return;
    handled.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (kind === "return") void refresh();
    else void openStripe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const data = status.data;
  const action = data ? connectAction(data) : "none";
  const actionKey = connectActionKey(action);
  const groups = data ? requirementGroups(data.requirementsDue) : [];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <CreditCard className="w-6 h-6" />
          {t("onlinePayments.title")}
        </h1>
        <p className="text-gray-500 mt-1">{t("onlinePayments.intro")}</p>
      </div>

      {status.isLoading && (
        <div className="flex items-center gap-2 text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      )}
      {status.isError && (
        <p className="text-red-600 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {t("onlinePayments.load_error")}
        </p>
      )}

      {data && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className={`text-sm font-semibold px-3 py-1 rounded-full ${connectStateClass(data.state)}`}>
              {t(connectStateKey(data.state))}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={working || data.state === "none"}
              className="inline-flex items-center gap-2 text-sm text-gray-600 disabled:opacity-40"
            >
              <RefreshCw className={`w-4 h-4 ${working ? "animate-spin" : ""}`} />
              {working ? t("onlinePayments.refreshing") : t("onlinePayments.refresh")}
            </button>
          </div>

          <p className="text-sm text-gray-700 flex items-start gap-2">
            {data.state === "active" && <CheckCircle2 className="w-4 h-4 mt-0.5 text-green-600 shrink-0" />}
            <span>
              {!data.platformReady
                ? t("onlinePayments.not_ready")
                : data.otherMode
                  ? t("onlinePayments.other_mode")
                  : t(`onlinePayments.${data.state}_text`)}
            </span>
          </p>

          {groups.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-semibold">{t("onlinePayments.needs_title")}</p>
              <ul className="mt-1 list-disc pl-5">
                {groups.map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </div>
          )}

          {data.disabledReason && (
            <p className="text-xs text-gray-500">{t("onlinePayments.disabled", { reason: data.disabledReason })}</p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {actionKey && (
              <button
                type="button"
                onClick={openStripe}
                disabled={working}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm disabled:opacity-40"
              >
                {working ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                {working ? t("onlinePayments.opening") : t(actionKey)}
              </button>
            )}
            {data.state !== "none" && (
              <a
                href="https://dashboard.stripe.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-gray-700 underline"
              >
                {t("onlinePayments.dashboard")}
              </a>
            )}
          </div>

          {data.checkedAt && (
            <p className="text-xs text-gray-400">
              {t("onlinePayments.checked", { date: new Date(data.checkedAt).toLocaleString("es-ES") })}
            </p>
          )}
        </div>
      )}

      {data && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t("onlinePayments.rules_title")}</h2>
          <label className="flex items-start gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={data.settings.depositExemptReturning}
              disabled={working}
              onChange={(e) => void setExempt(e.target.checked)}
              aria-describedby="rules-exempt-hint"
            />
            <span>
              {t("onlinePayments.exempt_label")}
              <span id="rules-exempt-hint" className="block text-xs text-gray-500">
                {t("onlinePayments.exempt_hint")}
              </span>
            </span>
          </label>
          <p className="text-sm text-gray-700">
            {t("onlinePayments.cancel_rule", { hours: data.settings.minCancelHours })}{" "}
            <Link href="/dashboard/settings" className="underline">
              {t("onlinePayments.cancel_change")}
            </Link>
          </p>
          <p className="text-xs text-gray-500">{t("onlinePayments.services_note")}</p>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="font-semibold text-gray-900">{t("onlinePayments.how_title")}</h2>
        <ol className="mt-2 list-decimal pl-5 space-y-1 text-sm text-gray-700">
          <li>{t("onlinePayments.how_1")}</li>
          <li>{t("onlinePayments.how_2")}</li>
          <li>{t("onlinePayments.how_3")}</li>
        </ol>
        <p className="mt-3 text-xs text-gray-500">{t("onlinePayments.fee_note")}</p>
      </div>
    </div>
  );
}

export default function CobrosOnlinePage() {
  return (
    <Suspense fallback={null}>
      <CobrosOnlineContent />
    </Suspense>
  );
}
