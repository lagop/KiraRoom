"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import apiClient from "../../../lib/api";
import type { SubscriptionInvoice } from "../../../lib/api";
import { useTenantContext } from "@/hooks/useFeatureAccess";
import { UsageMeters } from "@/components/billing/UsageMeters";
import { TrialBanner } from "@/components/billing/TrialBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PlanId } from "@/lib/plans";
import { Check, Globe, Loader2, Sparkles, X } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

export default function BillingPage() {
  const t = useTranslations();
  const ctx = useTenantContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sub, setSub] = useState<any>(null);
  const [plans, setPlans] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webDomain, setWebDomain] = useState<any | null>(null);
  const [showDomain, setShowDomain] = useState(false);
  const [invoices, setInvoices] = useState<SubscriptionInvoice[] | null>(null);
  const dateLocale = t("billing.invoices.dateFmt") || "es-ES";

  // P2A-receptionist-v2 -- AI counter + add-ons + message bundles
  const [addOns, setAddOns] = useState<any[] | null>(null);
  const [installedAddOns, setInstalledAddOns] = useState<any[] | null>(null);
  const [aiUsage, setAiUsage] = useState<
    { used: number; cap: number | null; resetsAt: string | null } | null
  >(null);
  const [bundles, setBundles] = useState<{
    creditsRemaining: number;
    creditsPurchasedTotal: number;
    creditsUsedTotal: number;
    lastTopupAt: string | null;
  } | null>(null);

  // M-2: confirm dialog state for add-on purchase + cancel.
  const [confirmAddOn, setConfirmAddOn] = useState<{
    key: string;
    action: "purchase" | "cancel";
  } | null>(null);

  // Banner surfaced when the user lands here from the channels wizard
  // (`?buy=multichannel`) or returns from Stripe (`?addOn=...&status=...`).
  const [flowBanner, setFlowBanner] = useState<{
    kind: "info" | "success" | "warning";
    message: string;
  } | null>(null);

  // H-4: when the wizard sends the user here, it supplies a
  // `returnTo` path that should be passed back to Stripe AND
  // followed after a successful purchase so the user lands back in
  // the wizard already unlocked.
  const returnToFromUrl = searchParams?.get("returnTo") ?? null;
  const [pendingReturnTo, setPendingReturnTo] = useState<string | null>(
    returnToFromUrl,
  );

  const cleanupQueryParams = useCallback(
    (params: string[]) => {
      // Strip the named query params so a refresh doesn't re-trigger
      // the side effects. Use router.replace to keep the page mounted.
      const sp = new URLSearchParams(searchParams?.toString() ?? "");
      for (const p of params) sp.delete(p);
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : "/dashboard/billing", { scroll: false });
    },
    [router, searchParams],
  );

  // Auto-open the add-on purchase modal when the channels wizard
  // redirected here with `?buy=multichannel`. Only fires once the
  // catalog has loaded and the add-on is actually available (so we
  // don't open a broken modal for an Esencial tenant that already
  // owns it, or for Pro/Empresa tenants where the add-on is hidden).
  useEffect(() => {
    if (!searchParams) return;
    const buyKey = searchParams.get("buy");
    if (!buyKey) return;
    if (!addOns) return; // catalog still loading
    if (installedAddOns?.some((row) => row?.addOn?.key === buyKey)) {
      // Already installed: surface a friendly notice, don't open the dialog.
      setFlowBanner({
        kind: "info",
        message: t("billing.addons.alreadyInstalled", { key: buyKey }),
      });
      cleanupQueryParams(["buy"]);
      return;
    }
    if (!addOns.some((row) => row?.key === buyKey)) {
      // The add-on isn't in the catalog for this tenant's plan
      // (Pro/Empresa where it's redundant). Surface a hint and let
      // the user browse plans instead.
      setFlowBanner({
        kind: "warning",
        message: t("billing.addons.notInCatalog", { key: buyKey }),
      });
      cleanupQueryParams(["buy"]);
      return;
    }
    setConfirmAddOn({ key: buyKey, action: "purchase" });
    cleanupQueryParams(["buy"]);
  }, [searchParams, addOns, installedAddOns, t, cleanupQueryParams]);

  // Handle the Stripe success / cancel return URLs set in
  // `tenant-addons.controller.ts`.
  useEffect(() => {
    if (!searchParams) return;
    const addOn = searchParams.get("addOn");
    const status = searchParams.get("status");
    if (!addOn || !status) return;
    const returnTo = searchParams.get("returnTo");
    if (status === "success") {
      setFlowBanner({
        kind: "success",
        message: t("billing.addons.purchaseSuccess", { key: addOn }),
      });
      // If the wizard asked us to bounce back, do it after a tick so
      // the user sees the success banner flash. Same-origin paths only.
      if (
        returnTo &&
        returnTo.startsWith("/") &&
        !returnTo.startsWith("//")
      ) {
        setTimeout(() => {
          window.location.href = returnTo;
        }, 1200);
      }
    } else if (status === "cancelled") {
      setFlowBanner({
        kind: "warning",
        message: t("billing.addons.purchaseCancelled", { key: addOn }),
      });
      // On cancel we DON'T redirect — let the user stay on the
      // billing page and retry when ready.
    }
    cleanupQueryParams(["addOn", "status", "returnTo"]);
  }, [searchParams, t, cleanupQueryParams]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, p, wd, i] = await Promise.all([
        apiClient.getCurrentSubscription().catch(() => null),
        apiClient.getSubscriptionPlans().catch(() => []),
        apiClient.request("/web-domain").catch(() => null),
        apiClient.getSubscriptionInvoices(12).catch(() => []),
      ]);
      setSub(s);
      setPlans((p as any) || []);
      setWebDomain(wd);
      setInvoices((i as SubscriptionInvoice[]) || []);

      // P2A-receptionist-v2 -- fetch add-ons + AI counter + bundles
      const plan = (s as any)?.plan ?? "esencial";
      const [catalog, installed, ai, wallet] = await Promise.all([
        apiClient.getAvailableAddOns(plan).catch(() => []),
        apiClient.getTenantAddOns().catch(() => []),
        apiClient.getAiUsage().catch(() => null),
        apiClient.getMessageBundlesBalance().catch(() => null),
      ]);
      setAddOns(catalog);
      setInstalledAddOns(installed);
      setAiUsage(ai);
      setBundles(wallet);
    } catch (e: any) {
      setError(e?.message || t("billing.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChoosePlan = async (planId: string) => {
    if (!confirm(t("billing.checkoutConfirm", { plan: planId }))) return;
    setWorking(planId);
    setError(null);
    try {
      const res = (await apiClient.createSubscriptionCheckout(planId)) as {
        url?: string;
        checkoutUrl?: string;
      };
      const url = res.checkoutUrl || res.url;
      if (url) {
        window.location.href = url;
      } else {
        alert(t("billing.checkoutDevNotice"));
      }
    } catch (e: any) {
      setError(e?.message || t("billing.checkoutError"));
    } finally {
      setWorking(null);
    }
  };

  const handleCancel = async () => {
    if (!confirm(t("billing.cancel.confirm"))) return;
    setWorking("cancel");
    try {
      await apiClient.cancelSubscription(false);
      await load();
    } catch (e: any) {
      setError(e?.message || t("billing.cancelError"));
    } finally {
      setWorking(null);
    }
  };

  const handleReactivate = async () => {
    setWorking("reactivate");
    try {
      const res = (await (apiClient as any).reactivateSubscription()) as {
        checkoutUrl?: string | null;
      };
      if (res?.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        await load();
      }
    } catch (e: any) {
      setError(e?.message || t("billing.reactivateError"));
    } finally {
      setWorking(null);
    }
  };

  const handlePurchaseAddOn = (key: string) => {
    setConfirmAddOn({ key, action: "purchase" });
  };

  const handleCancelAddOn = (key: string) => {
    setConfirmAddOn({ key, action: "cancel" });
  };

  const performAddOnAction = async () => {
    if (!confirmAddOn) return;
    const { key, action } = confirmAddOn;
    setWorking(key);
    setError(null);
    try {
      if (action === "purchase") {
        // The backend creates a Stripe Checkout session and returns
        // `{ url }`. Redirect the browser so the user lands on
        // Stripe's hosted page; the success/cancel URLs bounce back
        // here and the effect above handles the return.
        const res = (await apiClient.requestAddOnCheckout(key, {
          returnTo: pendingReturnTo ?? undefined,
        })) as {
          url?: string;
          checkoutUrl?: string;
        };
        const url = res?.checkoutUrl || res?.url;
        if (url) {
          window.location.href = url;
          // Do not call setConfirmAddOn(null) — the page is navigating
          // away. The component will unmount on the redirect.
          return;
        }
        // Fallback (dev mode / no Stripe configured): refresh the
        // installed list so the UI reflects the manual grant.
        await load();
      } else {
        await apiClient.cancelTenantAddOn(key);
        await load();
      }
    } catch (e: any) {
      setError(e?.message || t("billing.addons.error"));
    } finally {
      setWorking(null);
      setConfirmAddOn(null);
    }
  };

  const handleOpenBillingPortal = async () => {
    setWorking("portal");
    setError(null);
    try {
      const res = await apiClient.getBillingPortalUrl();
      if (res?.url) {
        window.open(res.url, "_blank", "noopener,noreferrer");
      } else {
        setError(t("billing.managePortal.unavailable"));
      }
    } catch (e: any) {
      setError(e?.message || t("billing.portalError"));
    } finally {
      setWorking(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("billing.loading")}
      </div>
    );
  }

  const currentPlan: PlanId = (sub?.plan as PlanId) || "esencial";
  const isCancelled = sub?.status === "cancelled";
  const isTrialing = sub?.status === "trialing";

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">{t("billing.title")}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t("billing.subtitle")}
        </p>
      </header>

      {ctx.inTrial && <TrialBanner />}

      {flowBanner && (
        <div
          className={
            "flex items-start gap-3 rounded-md border p-4 text-sm " +
            (flowBanner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : flowBanner.kind === "warning"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-violet-200 bg-violet-50 text-violet-900")
          }
          role="status"
        >
          <Sparkles className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div className="flex-1">{flowBanner.message}</div>
          <button
            onClick={() => setFlowBanner(null)}
            className="ml-auto text-current opacity-60 hover:opacity-100"
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {isCancelled && (
        <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-red-900">
          <X className="mt-0.5 h-5 w-5" />
          <div className="flex-1 text-sm">
            <p className="font-semibold">{t("billing.cancelled.title")}</p>
            <p>
              {t("billing.cancelled.body", {
                date: sub?.readOnlyUntil
                  ? new Date(sub.readOnlyUntil).toLocaleDateString(dateLocale)
                  : "\u2014",
              })}
            </p>
            <button
              onClick={handleReactivate}
              disabled={working === "reactivate"}
              className="mt-2 inline-flex items-center gap-1 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {working === "reactivate"
                ? t("billing.reactivate.doing")
                : t("billing.reactivate.cta")}
            </button>
          </div>
        </div>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700">
            {t(`plans.${currentPlan}`)}
          </span>
          <StatusBadge status={sub?.status} t={t} />
          {sub?.trialEnd && isTrialing && (
            <span className="text-xs text-gray-500">
              {t("billing.trialUntil", {
                date: new Date(sub.trialEnd).toLocaleDateString(dateLocale),
              })}
            </span>
          )}
          {sub?.currentPeriodEnd && !isCancelled && (
            <span className="text-xs text-gray-500">
              {t("billing.nextCharge", {
                date: new Date(sub.currentPeriodEnd).toLocaleDateString(dateLocale),
              })}
            </span>
          )}
          {!isCancelled && (
            <button
              onClick={handleCancel}
              disabled={working === "cancel"}
              className="ml-auto text-xs text-red-600 underline hover:text-red-700"
            >
              {working === "cancel"
                ? t("billing.cancel.doing")
                : t("billing.cancel.cta")}
            </button>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
          {t("billing.usage.title")}
        </h2>
        <UsageMeters />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
          {t("billing.changePlan")}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans?.map((p: any) => {
            const isCurrent = p.id === currentPlan;
            return (
              <div
                key={p.id}
                className={"rounded-lg border p-5 shadow-sm " + (isCurrent ? "border-violet-300 bg-violet-50/40" : "border-gray-200 bg-white")}
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {t(`plans.${p.id}`)}
                  </h3>
                  {p.id === "pro" && (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      {t("landing.pricing.popular")}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-2xl font-bold text-gray-900">
                  €{p.price / 100}
                  <span className="ml-1 text-sm font-normal text-gray-500">
                    {t("landing.pricing.perMonth")}
                  </span>
                </p>
                {p.id === "empresa" && (
                  <p className="text-xs text-gray-500">
                    {t("landing.pricing.minLocations")}
                  </p>
                )}
                <ul className="mt-3 space-y-1.5 text-sm text-gray-600">
                  {(p.features ?? []).slice(0, 6).map((f: string) => (
                    <li key={f} className="flex items-start gap-1.5">
                      <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => handleChoosePlan(p.id)}
                  disabled={isCurrent || working === p.id}
                  className={"mt-4 w-full rounded-md px-3 py-2 text-sm font-medium " + (isCurrent ? "bg-gray-100 text-gray-400" : "bg-violet-600 text-white hover:bg-violet-700") + " disabled:opacity-50"}
                >
                  {isCurrent
                    ? t("billing.currentPlanLabel")
                    : working === p.id
                      ? t("billing.processing")
                      : t("billing.choosePlan")}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
          {t("billing.addons")}
        </h2>
        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-gray-900">
                {t("billing.webDomain.title")}
              </h3>
              <p className="mt-1 text-sm text-gray-600">
                {t("billing.webDomain.desc")}
              </p>
              {webDomain?.enabled && webDomain?.domain && (
                <p className="mt-2 text-xs text-emerald-700">
                  {t("billing.webDomain.active", { domain: webDomain.domain })}
                </p>
              )}
            </div>
            {webDomain?.enabled ? (
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                {t("billing.webDomain.activeShort")}
              </span>
            ) : (
              <button
                onClick={() => setShowDomain(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
              >
                <Globe className="h-4 w-4" />
                {t("billing.webDomain.addDomain")}
              </button>
            )}
          </div>
        </div>
      </section>

      <InvoicesList invoices={invoices ?? []} t={t} dateLocale={dateLocale} />

      {/* P2A-receptionist-v2 -- AI usage counter */}
      {aiUsage && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
            {t("billing.aiUsage.title")}
          </h2>
          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <AiUsageMeter ai={aiUsage} t={t} />
          </div>
        </section>
      )}

      {/* P2A-receptionist-v2 -- Add-on grid */}
      {addOns && addOns.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
            {t("billing.addons.title")}
          </h2>
          <AddOnGrid
            addOns={addOns}
            installed={installedAddOns ?? []}
            t={t}
            onPurchase={handlePurchaseAddOn}
            onCancel={handleCancelAddOn}
            working={working}
          />
        </section>
      )}

      {/* P2A-receptionist-v2 -- message bundles balance (metered) */}
      {bundles && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
            {t("billing.bundles.title")}
          </h2>
          <BundlesBalanceCard bundles={bundles} t={t} />
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
          {t("billing.managePortal.title")}
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-gray-600">
            {t("billing.managePortal.desc")}
          </p>
          <button
            onClick={handleOpenBillingPortal}
            disabled={working === "portal"}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {working === "portal"
              ? t("billing.managePortal.opening")
              : t("billing.managePortal.cta")}
          </button>
        </div>
      </section>

      {showDomain && (
        <DomainDialog
          onClose={() => setShowDomain(false)}
          onDone={() => {
            setShowDomain(false);
            load();
          }}
          t={t}
          dateLocale={dateLocale}
        />
      )}

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={!!confirmAddOn}
        title={
          confirmAddOn?.action === "purchase"
            ? t("billing.addons.confirmPurchase", { key: confirmAddOn?.key ?? "" })
            : t("billing.addons.confirmCancel", { key: confirmAddOn?.key ?? "" })
        }
        description={t("billing.addons.confirmDescription")}
        confirmLabel={
          confirmAddOn?.action === "purchase"
            ? t("billing.addons.subscribe")
            : t("billing.addons.cancel")
        }
        destructive={confirmAddOn?.action === "cancel"}
        loading={!!confirmAddOn && !!working}
        onCancel={() => setConfirmAddOn(null)}
        onConfirm={performAddOnAction}
      />
    </div>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: string;
  t: (key: string) => string;
}) {
  const styles: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-700",
    trialing: "bg-blue-100 text-blue-700",
    cancelled: "bg-red-100 text-red-700",
    past_due: "bg-amber-100 text-amber-700",
  };
  return (
    <span
      className={
        "rounded-full px-3 py-1 text-xs font-semibold " +
        (styles[status] || "bg-gray-100 text-gray-700")
      }
    >
      {t(`billing.status.${status}`) || status}
    </span>
  );
}

function DomainDialog({
  onClose,
  onDone,
  t,
  dateLocale,
}: {
  onClose: () => void;
  onDone: () => void;
  t: (key: string, params?: Record<string, any>) => string;
  dateLocale: string;
}) {
  const [domain, setDomain] = useState("");
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState<any | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = (await apiClient.request("/web-domain/check-availability", {
        method: "POST",
        body: JSON.stringify({ domain }),
      })) as any;
      setAvailability(res);
    } catch (e: any) {
      setError(e?.message || t("common.error"));
    } finally {
      setChecking(false);
    }
  };

  const purchase = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = (await apiClient.request("/web-domain/purchase", {
        method: "POST",
        body: JSON.stringify({ domain }),
      })) as any;
      if (res?.checkoutRequired) {
        alert(t("billing.webDomain.dialog.checkoutRequired"));
      } else {
        onDone();
      }
    } catch (e: any) {
      setError(e?.message || t("common.error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-900">
          {t("billing.webDomain.dialog.title")}
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          {t("billing.webDomain.dialog.desc")}
        </p>
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder={t("billing.webDomain.dialog.placeholder")}
          className="mt-3 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
        />
        {availability && (
          <p
            className={
              "mt-2 text-xs " + (availability.available ? "text-emerald-700" : "text-red-600")
            }
          >
            {availability.available
              ? t("billing.webDomain.availableFmt", { domain: availability.domain })
              : t("billing.webDomain.domainNotAvailable", { domain: availability.domain })}
          </p>
        )}
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            {t("billing.webDomain.dialog.cancel")}
          </button>
          <button
            onClick={check}
            disabled={!domain || checking}
            className="rounded-md border border-violet-200 px-3 py-1.5 text-sm text-violet-700 hover:bg-violet-50 disabled:opacity-50"
          >
            {checking
              ? t("billing.webDomain.dialog.checking")
              : t("billing.webDomain.dialog.check")}
          </button>
          <button
            onClick={purchase}
            disabled={!availability?.available || submitting}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {submitting
              ? t("billing.webDomain.dialog.processing")
              : t("billing.webDomain.dialog.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoicesList({
  invoices,
  t,
  dateLocale,
}: {
  invoices: SubscriptionInvoice[];
  t: (key: string, params?: Record<string, any>) => string;
  dateLocale: string;
}) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
        {t("billing.invoices.title")}
      </h2>
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
        {invoices.length === 0 ? (
          <p className="p-5 text-sm text-gray-500">{t("billing.invoices.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium whitespace-nowrap">{t("billing.invoices.date")}</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap">{t("billing.invoices.number")}</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap">{t("billing.invoices.amount")}</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap">{t("billing.invoices.status")}</th>
                <th className="px-4 py-2 font-medium text-right whitespace-nowrap">{t("billing.invoices.recibo")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td className="px-4 py-2 whitespace-nowrap text-gray-700">
                    {new Date(inv.created).toLocaleDateString(dateLocale)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600">
                    {inv.number || inv.id}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap font-medium text-gray-900">
                    €{(inv.amount / 100).toFixed(2)}
                  </td>
                  <td className="px-4 py-2">
                    <InvoiceStatusBadge status={inv.status} t={t} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    {inv.invoiceUrl ? (
                      <a
                        href={inv.invoiceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-violet-600 underline hover:text-violet-700"
                      >
                        {t("billing.invoices.open")}
                      </a>
                    ) : (
                      <span className="text-gray-400">{t("billing.invoices.dash")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </section>
  );
}

function InvoiceStatusBadge({
  status,
  t,
}: {
  status: string;
  t: (key: string) => string;
}) {
  const styles: Record<string, string> = {
    paid: "bg-emerald-100 text-emerald-700",
    open: "bg-amber-100 text-amber-700",
    void: "bg-gray-100 text-gray-600",
    draft: "bg-gray-100 text-gray-600",
    uncollectible: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={
        "rounded-full px-2.5 py-0.5 text-xs font-medium " +
        (styles[status] || "bg-gray-100 text-gray-700")
      }
    >
      {t(`billing.invoices.status${status.charAt(0).toUpperCase() + status.slice(1)}`) || status}
    </span>
  );
}

// ─────────── P2A-receptionist-v2 ───────────

/** AI usage meter: X / 500 conversations this month + reset date. */
function AiUsageMeter({
  ai,
  t,
}: {
  ai: { used: number; cap: number | null; resetsAt: string | null };
  t: (key: string, params?: any) => string;
}) {
  if (ai.cap === null) {
    return (
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900">
            {t("billing.aiUsage.unlimitedTitle")}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {t("billing.aiUsage.unlimitedDesc")}
          </p>
        </div>
        <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700">
          {t("billing.aiUsage.unlimitedBadge")}
        </span>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((ai.used / ai.cap) * 100));
  const danger = pct >= 90;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm font-medium text-gray-900">
          <span className="text-2xl font-bold text-gray-900">{ai.used}</span>
          <span className="text-sm text-gray-500"> / {ai.cap}</span>
        </p>
        {ai.resetsAt && (
          <p className="text-xs text-gray-500">
            {t("billing.aiUsage.resetsAt", {
              date: new Date(ai.resetsAt).toLocaleDateString(
                t("billing.invoices.dateFmt") || "es-ES",
              ),
            })}
          </p>
        )}
      </div>
      <div
        className={
          "h-2 w-full overflow-hidden rounded-full bg-gray-100"
        }
      >
        <div
          className={
            "h-full transition-all " +
            (danger ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-indigo-500")
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-gray-500">
        {t("billing.aiUsage.legend", { pct })}
      </p>
    </div>
  );
}

/** Add-on grid: catalog cards with status (active / available) + CTAs. */
function AddOnGrid({
  addOns,
  installed,
  t,
  onPurchase,
  onCancel,
  working,
}: {
  addOns: any[];
  installed: any[];
  t: (key: string, params?: any) => string;
  onPurchase: (key: string) => void;
  onCancel: (key: string) => void;
  working: string | null;
}) {
  const installedByKey = new Map(
    installed.map((i) => [i.addOn?.key ?? i.addOnKey, i]),
  );
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {addOns.map((a) => {
        const inst = installedByKey.get(a.key);
        const isActive = inst?.status === "active";
        const price = a.monthlyPriceCents
          ? `€${(a.monthlyPriceCents / 100).toFixed(2)} / ${t("billing.addons.perMonth")}`
          : a.metered
            ? t("billing.addons.metered")
            : t("billing.addons.included");
        return (
          <article
            key={a.id}
            className={
              "flex flex-col rounded-lg border bg-white p-4 shadow-sm " +
              (isActive
                ? "border-emerald-300 ring-1 ring-emerald-200"
                : "border-gray-200")
            }
          >
            <header className="mb-2 flex items-start justify-between gap-2">
              <h3 className="text-sm font-semibold text-gray-900">{a.name}</h3>
              {isActive && (
                <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  {t("billing.addons.activeBadge")}
                </span>
              )}
              {a.metered && !isActive && (
                <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                  {t("billing.addons.meteredBadge")}
                </span>
              )}
            </header>
            <p className="mb-3 text-xs text-gray-600">{a.description}</p>
            <dl className="mb-4 space-y-1 text-xs text-gray-500">
              <div className="flex justify-between">
                <dt>{t("billing.addons.price")}</dt>
                <dd className="font-medium text-gray-900">{price}</dd>
              </div>
              {a.unlocks.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {a.unlocks.map((u: string) => (
                    <span
                      key={u}
                      className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600"
                    >
                      {u}
                    </span>
                  ))}
                </div>
              )}
            </dl>
            <div className="mt-auto flex gap-2">
              {isActive ? (
                <button
                  onClick={() => onCancel(a.key)}
                  disabled={working === a.key}
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {working === a.key
                    ? t("billing.addons.working")
                    : t("billing.addons.cancel")}
                </button>
              ) : (
                <button
                  onClick={() => onPurchase(a.key)}
                  disabled={working === a.key}
                  className="w-full rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {working === a.key
                    ? t("billing.addons.working")
                    : t("billing.addons.subscribe")}
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

/** Message-bundles wallet balance. Pure read-only. Top-up happens via
 *  the SaaS-admin / Stripe flow (Phase 4 webhook). */
function BundlesBalanceCard({
  bundles,
  t,
}: {
  bundles: {
    creditsRemaining: number;
    creditsPurchasedTotal: number;
    creditsUsedTotal: number;
    lastTopupAt: string | null;
  };
  t: (key: string, params?: any) => string;
}) {
  const pct = bundles.creditsPurchasedTotal
    ? Math.min(
        100,
        Math.round(
          (bundles.creditsUsedTotal / bundles.creditsPurchasedTotal) * 100,
        ),
      )
    : 0;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-sm font-medium text-gray-900">
          {t("billing.bundles.title")}
        </p>
        <p className="text-xs text-gray-500">
          {t("billing.bundles.consumedFmt", {
            used: bundles.creditsUsedTotal,
            purchased: bundles.creditsPurchasedTotal,
          })}
        </p>
      </div>
      <div className="mb-2 flex items-baseline gap-2">
        <p className="text-3xl font-bold text-gray-900">
          {bundles.creditsRemaining}
        </p>
        <p className="text-sm text-gray-500">{t("billing.bundles.creditsRemaining")}</p>
      </div>
      {bundles.creditsPurchasedTotal > 0 && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full bg-indigo-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p className="mt-3 text-xs text-gray-500">
        {t("billing.bundles.desc")}
      </p>
      {bundles.lastTopupAt && (
        <p className="mt-1 text-xs text-gray-400">
          {t("billing.bundles.lastTopupFmt", {
            date: new Date(bundles.lastTopupAt).toLocaleDateString(
              t("billing.invoices.dateFmt") || "es-ES",
            ),
          })}
        </p>
      )}
    </div>
  );
}
