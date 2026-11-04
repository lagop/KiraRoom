"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import apiClient from "../../../lib/api";
import type { PlanLimitBlocker, SubscriptionInvoice } from "../../../lib/api";
import { useTenantContext } from "@/hooks/useFeatureAccess";
import { UsageMeters } from "@/components/billing/UsageMeters";
import { TrialBanner } from "@/components/billing/TrialBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PlanId } from "@/lib/plans";
import { empresaLocations, planAction, paysSubscription, scheduledCancellation, subscribedInTrial } from "@/lib/billing-plan";
import { getCurrentUser } from "@/lib/utils";
import { isOwner } from "@/lib/dashboard-nav";
import { aiConversationsApprox } from "@kira/shared";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import { addOnDisplayName, formatSubscriptionAmount } from "@/lib/billing-plan";
import { checkoutReturnMessage, shouldKeepPolling } from "@/lib/checkout-return";
import { forgetDesiredPlan, readDesiredPlan } from "@/lib/desired-plan";

function BillingPageContent() {
  const t = useTranslations();
  const { toast } = useToast();
  const ctx = useTenantContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Facturación is the owner's (every billing route answers admins 403):
  // read the role after mount (the server has no token) and send anyone
  // else to the dashboard before any request is made.
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  useEffect(() => {
    if (role !== undefined && !isOwner(role)) router.replace("/dashboard");
  }, [role, router]);
  const [sub, setSub] = useState<any>(null);
  const [plans, setPlans] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<SubscriptionInvoice[] | null>(null);
  const dateLocale = t("billing.invoices.dateFmt") || "es-ES";
  // The plan picked on the website before signing up (B12): its card is
  // highlighted until the salon pays for a plan.
  const [desiredPlan, setDesiredPlan] = useState<PlanId | null>(null);
  useEffect(() => setDesiredPlan(readDesiredPlan()), []);
  useEffect(() => {
    if (desiredPlan && paysSubscription(sub)) {
      forgetDesiredPlan();
      setDesiredPlan(null);
    }
  }, [desiredPlan, sub]);

  // P2A-receptionist-v2 -- AI counter + add-ons + message bundles
  const [addOns, setAddOns] = useState<any[] | null>(null);
  const [installedAddOns, setInstalledAddOns] = useState<any[] | null>(null);
  const [aiUsage, setAiUsage] = useState<
    { used: number; cap: number | null; resetsAt: string | null } | null
  >(null);

  // M-2: confirm dialog state for add-on purchase + cancel.
  // The plan the salon is about to subscribe to or switch to, and whether it
  // is about to cancel: confirmed in the panel's dialog, not window.confirm.
  // `blockers`: what the salon must deactivate first (B9); the dialog then
  // lists it instead of going to Stripe.
  const [pendingPlan, setPendingPlan] = useState<{
    planId: string;
    change: boolean;
    blockers: PlanLimitBlocker[];
  } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Empresa: the locations the subscription pays for (B8).
  const [locationsDraft, setLocationsDraft] = useState<number | null>(null);
  const [confirmLocations, setConfirmLocations] = useState(false);
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
    const buyName = addOnDisplayName(buyKey, addOns, installedAddOns);
    if (installedAddOns?.some((row) => row?.addOn?.key === buyKey)) {
      // Already installed: surface a friendly notice, don't open the dialog.
      setFlowBanner({
        kind: "info",
        message: t("billing.addons.alreadyInstalled", { key: buyName }),
      });
      cleanupQueryParams(["buy"]);
      return;
    }
    const wanted = addOns.find((row) => row?.key === buyKey);
    if (wanted && !wanted.purchasable) {
      // Listed as "Próximamente": nothing to buy yet.
      setFlowBanner({
        kind: "info",
        message: t("billing.addons.comingSoonNotice", { key: wanted.name ?? buyKey }),
      });
      cleanupQueryParams(["buy"]);
      return;
    }
    if (!wanted) {
      // The add-on isn't in the catalog for this tenant's plan
      // (Pro/Empresa where it's redundant). Surface a hint and let
      // the user browse plans instead.
      setFlowBanner({
        kind: "warning",
        message: t("billing.addons.notInCatalog", { key: buyName }),
      });
      cleanupQueryParams(["buy"]);
      return;
    }
    if (!canBuyAddOnsOf(sub)) {
      // In trial or without a paid subscription the backend refuses it:
      // say so instead of opening a dialog that would fail.
      setFlowBanner({ kind: "info", message: t("billing.addons.needsPaidPlan") });
      cleanupQueryParams(["buy"]);
      return;
    }
    setConfirmAddOn({ key: buyKey, action: "purchase" });
    cleanupQueryParams(["buy"]);
  }, [searchParams, addOns, installedAddOns, sub, t, cleanupQueryParams]);

  // Handle the Stripe success / cancel return URLs set in
  // `tenant-addons.controller.ts`.
  useEffect(() => {
    if (!searchParams) return;
    const addOn = searchParams.get("addOn");
    const status = searchParams.get("status");
    if (!addOn || !status) return;
    const returnTo = searchParams.get("returnTo");
    // The name, not the internal key; the catalogue may still be loading.
    const addOnName = addOnDisplayName(addOn, addOns, installedAddOns);
    if (status === "success") {
      setFlowBanner({
        kind: "success",
        message: t("billing.addons.purchaseSuccess", { key: addOnName }),
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
        message: t("billing.addons.purchaseCancelled", { key: addOnName }),
      });
      // On cancel we DON'T redirect — let the user stay on the
      // billing page and retry when ready.
    }
    cleanupQueryParams(["addOn", "status", "returnTo"]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, t, cleanupQueryParams]);

  // Back from the plan checkout (subscriptions.service createCheckoutSession:
  // ?subscription=success&session_id=...|cancelled). The page asks the
  // backend what Stripe says about that session (B15): in the free trial
  // only the card was saved, so it says when the first charge comes instead
  // of "Pago recibido". Stripe's webhook applies the plan, which can take a
  // while: the session is asked again until the plan is applied (about 40
  // seconds), and the page reloads the subscription when it is.
  useEffect(() => {
    if (!isOwner(role)) return;
    const result = searchParams?.get("subscription");
    if (!result) return;
    const sessionId = searchParams?.get("session_id");
    const timers: ReturnType<typeof setTimeout>[] = [];
    let stopped = false;
    if (result === "success" && sessionId) {
      const MAX_ATTEMPTS = 10;
      const ask = async (attempt: number) => {
        const session = await apiClient.getCheckoutSessionStatus(sessionId).catch(() => null);
        if (stopped) return;
        if (attempt === 0) {
          const message = checkoutReturnMessage(session);
          if (message.kind === "cardSaved") {
            toast({
              title: t("billing.checkoutReturn.cardSavedTitle", {
                date: new Date(message.firstChargeAt).toLocaleDateString(dateLocale, {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                }),
              }),
              description: t("billing.checkoutReturn.cardSavedBody"),
            });
          } else if (message.kind === "paid") {
            toast({ title: t("billing.checkoutReturn.successTitle"), description: t("billing.checkoutReturn.successBody") });
          } else {
            toast({ title: t("billing.checkoutReturn.pendingTitle"), description: t("billing.checkoutReturn.pendingBody") });
          }
        }
        if (session?.applied) {
          load();
          return;
        }
        if (shouldKeepPolling(session, attempt + 1, MAX_ATTEMPTS)) {
          timers.push(setTimeout(() => ask(attempt + 1), 4000));
        } else if (session?.status === "complete") {
          load();
          toast({ title: t("billing.checkoutReturn.pendingTitle"), description: t("billing.checkoutReturn.slowBody") });
        }
      };
      ask(0);
    } else if (result === "success") {
      // An older return link without the session: as before.
      toast({ title: t("billing.checkoutReturn.successTitle"), description: t("billing.checkoutReturn.successBody") });
      load();
      timers.push(setTimeout(() => load(), 4000), setTimeout(() => load(), 10000));
    } else if (result === "cancelled" || result === "cancel") {
      toast({ title: t("billing.checkoutReturn.cancelTitle"), description: t("billing.checkoutReturn.cancelBody") });
    }
    cleanupQueryParams(["subscription", "session_id"]);
    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, role]);

  const load = async () => {
    setLoading(true);
    setError(null);
    // Each request still falls back so the rest of the page renders, but a
    // failure is reported: silently, a failed subscription load read as "no
    // plan" and the add-on catalogue as the Esencial one -- a paying salon
    // could be invited to buy what it already has.
    const failed: string[] = [];
    const soft = <T,>(name: string, request: Promise<T>, fallback: T) =>
      request.catch((err) => {
        console.error(`Billing: ${name} failed to load:`, err);
        failed.push(name);
        return fallback;
      });
    try {
      // The "Web con dominio propio + SEO" add-on card was here, selling a
      // domain purchase that only flipped a flag. Connecting a salon's own
      // domain now lives in Ajustes > Web y dominio, and is not sold until
      // it is served over HTTPS (see docs/custom-domains.md).
      const [s, p, i] = await Promise.all([
        soft("subscription", apiClient.getCurrentSubscription(), null as any),
        soft("plans", apiClient.getSubscriptionPlans(), [] as any[]),
        soft("invoices", apiClient.getSubscriptionInvoices(12), [] as any[]),
      ]);
      setSub(s);
      setPlans((p as any) || []);
      setInvoices((i as SubscriptionInvoice[]) || []);

      // P2A-receptionist-v2 -- fetch add-ons + AI counter. (The SMS
      // "Bonos de mensajes" card was here: SMS campaigns do not exist.)
      // No catalogue for a plan we could not read.
      const plan = failed.includes("subscription") ? null : ((s as any)?.plan ?? "esencial");
      const [catalog, installed, ai] = await Promise.all([
        plan ? soft("addOns", apiClient.getAvailableAddOns(plan), [] as any[]) : Promise.resolve([] as any[]),
        soft("installedAddOns", apiClient.getTenantAddOns(), [] as any[]),
        soft("aiUsage", apiClient.getAiUsage(), null as any),
      ]);
      setAddOns(catalog);
      setInstalledAddOns(installed);
      setAiUsage(ai);
      setLocationsDraft(null);
      if (failed.length > 0) setError(t("billing.loadError"));
    } catch (e: any) {
      setError(e?.message || t("billing.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOwner(role)) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const handleChoosePlan = async (planId: string) => {
    // What the salon must deactivate first (B9), asked before Stripe. If
    // the check itself fails, the dialog goes on: the backend checks again.
    setWorking(`check:${planId}`);
    let blockers: PlanLimitBlocker[] = [];
    try {
      blockers = (await apiClient.getPlanCheck(planId))?.blockers ?? [];
    } catch (err) {
      console.error("Billing: plan check failed:", err);
    } finally {
      setWorking(null);
    }
    // A salon that already pays changes the plan of its subscription: a
    // checkout would open a second one, billed on top.
    setPendingPlan({ planId, change: paysSubscription(sub), blockers });
  };

  const performChoosePlan = async () => {
    if (!pendingPlan) return;
    const { planId, change, blockers } = pendingPlan;
    if (blockers.length > 0) {
      // Nothing to send to Stripe yet: take the owner to the first thing to deactivate.
      setPendingPlan(null);
      router.push(blockers[0].href);
      return;
    }
    const plan = t(`plans.${planId}`);
    if (change) {
      setWorking(planId);
      setError(null);
      try {
        await apiClient.changeSubscriptionPlan(planId);
        await load();
        setFlowBanner({ kind: "success", message: t("billing.switchDone", { plan }) });
      } catch (e: any) {
        setError(e?.message || t("billing.checkoutError"));
      } finally {
        setWorking(null);
        setPendingPlan(null);
      }
      return;
    }
    setWorking(planId);
    setError(null);
    try {
      const res = (await apiClient.createSubscriptionCheckout(planId)) as {
        url?: string;
        checkoutUrl?: string;
      };
      const url = res.checkoutUrl || res.url;
      if (url) {
        // The dialog stays up, busy, until Stripe's page loads.
        window.location.href = url;
        return;
      }
      setError(t("billing.checkoutDevNotice"));
    } catch (e: any) {
      setError(e?.message || t("billing.checkoutError"));
    }
    setWorking(null);
    setPendingPlan(null);
  };

  const handleCancel = async () => {
    setConfirmCancel(false);
    setWorking("cancel");
    try {
      // A paid subscription ends with its period (cancelAt); until then
      // the salon keeps everything (B3).
      const res: any = await apiClient.cancelSubscription();
      await load();
      if (res?.cancelAt) {
        toast({ title: t("billing.cancel.scheduledToast", { date: new Date(res.cancelAt).toLocaleDateString(dateLocale) }) });
      }
    } catch (e: any) {
      setError(e?.message || t("billing.cancelError"));
    } finally {
      setWorking(null);
    }
  };

  const handleUndoCancel = async () => {
    setWorking("undo-cancel");
    setError(null);
    try {
      await apiClient.undoCancelSubscription();
      await load();
      toast({ title: t("billing.cancel.undone") });
    } catch (e: any) {
      setError(e?.message || t("billing.cancel.undoError"));
    } finally {
      setWorking(null);
    }
  };

  const handleSaveLocations = async () => {
    if (locationsDraft === null) return;
    setWorking("locations");
    setError(null);
    try {
      await apiClient.updateSubscriptionLocations(locationsDraft);
      await load();
      toast({ title: t("billing.locations.done", { count: locationsDraft }) });
    } catch (e: any) {
      setError(e?.message || t("billing.locations.error"));
    } finally {
      setWorking(null);
      setConfirmLocations(false);
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
        // The add-on is added to the plan subscription (prorated on the
        // next invoice) and the answer is the row as Stripe left it: the
        // banner says "activo" only when it is.
        const row = await apiClient.purchaseAddOn(key);
        await load();
        if (row?.status === "active") {
          setFlowBanner({
            kind: "success",
            message: t("billing.addons.purchaseSuccess", { key: addOnDisplayName(key, addOns, installedAddOns) }),
          });
          if (
            pendingReturnTo &&
            pendingReturnTo.startsWith("/") &&
            !pendingReturnTo.startsWith("//")
          ) {
            const target = pendingReturnTo;
            setPendingReturnTo(null);
            setTimeout(() => {
              window.location.href = target;
            }, 1200);
          }
        } else {
          setFlowBanner({
            kind: "warning",
            message: t("billing.addons.purchasePending", { key: addOnDisplayName(key, addOns, installedAddOns) }),
          });
        }
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

  if (loading || !isOwner(role)) {
    return (
      <div className="flex items-center gap-2 p-8 text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("billing.loading")}
      </div>
    );
  }

  const currentPlan: PlanId = (sub?.plan as PlanId) || "esencial";
  const isCancelled = sub?.status === "cancelled";
  const isTrialing = sub?.status === "trialing";
  // The plan the salon has now: Pro during the trial, though it is stored
  // as Esencial until it subscribes.
  const shownPlan: PlanId = (sub?.effectivePlan as PlanId) || currentPlan;
  const inTrial: boolean =
    sub?.inTrial ?? (isTrialing && !!sub?.trialEnd && new Date(sub.trialEnd).getTime() > Date.now());
  const canBuyAddOns = canBuyAddOnsOf(sub);
  // Cancelled at the end of the paid period: still everything until then (B3).
  const cancelsOn = scheduledCancellation(sub);
  const cancelsOnText = cancelsOn ? new Date(cancelsOn).toLocaleDateString(dateLocale) : null;
  // Subscribed during the trial: the trial (Pro) goes on until it ends (B6).
  const trialSubscribed = subscribedInTrial(sub);
  // Empresa: paid locations against the ones open (B8).
  const locations = empresaLocations(sub);
  const locationsValue = locationsDraft ?? locations?.paid ?? 1;
  const planById = (id: string) => plans?.find((p: any) => p.id === id);
  // "49 €" or, on Empresa, "149 € por local": the copy adds "al mes + IVA".
  const planPriceText = (id: string) => {
    const p = planById(id);
    if (!p) return "";
    const amount = t("landing.pricing.price", { amount: p.price / 100 });
    return p.pricePerLocation ? `${amount} ${t("landing.pricing.perLocation")}` : amount;
  };
  const empresaPriceText = (() => {
    const p = planById("empresa");
    return p ? t("landing.pricing.price", { amount: (p.pricePerLocation ?? p.price) / 100 }) : "";
  })();
  const confirmAddOnPrice = (() => {
    const row = confirmAddOn ? addOns?.find((a) => a?.key === confirmAddOn.key) : null;
    return row?.monthlyPriceCents ? formatSubscriptionAmount(row.monthlyPriceCents, row.currency) : "";
  })();

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">{t("billing.title")}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t("billing.subtitle")}
        </p>
      </header>

      {/* Already subscribed in the trial: nothing left to choose. */}
      {ctx.inTrial && !paysSubscription(sub) && <TrialBanner />}

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
            {!(sub?.trialEnd && new Date(sub.trialEnd).getTime() > Date.now()) && (
              // Out of trial, reactivating is a payment (in trial it just
              // returns to the trial).
              <p className="mt-2 text-xs text-red-800">{t("billing.reactivate.hint")}</p>
            )}
          </div>
        </div>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700">
            {t(`plans.${shownPlan}`)}
          </span>
          <StatusBadge status={sub?.status} t={t} />
          {sub?.trialEnd && isTrialing && (
            <span className="text-xs text-gray-500">
              {t("billing.trialUntil", {
                date: new Date(sub.trialEnd).toLocaleDateString(dateLocale),
              })}
            </span>
          )}
          {sub?.currentPeriodEnd && !isCancelled && !cancelsOn && !trialSubscribed && paysSubscription(sub) && (
            <span className="text-xs text-gray-500">
              {t("billing.nextCharge", {
                date: new Date(sub.currentPeriodEnd).toLocaleDateString(dateLocale),
              })}
            </span>
          )}
          {cancelsOnText && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
              {t("billing.cancel.scheduled", { date: cancelsOnText })}
            </span>
          )}
          {cancelsOn ? (
            <button
              onClick={handleUndoCancel}
              disabled={working === "undo-cancel"}
              className="ml-auto rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {working === "undo-cancel" ? t("billing.cancel.undoing") : t("billing.cancel.undo")}
            </button>
          ) : !isCancelled && (
            <button
              onClick={() => setConfirmCancel(true)}
              disabled={working === "cancel"}
              className="ml-auto text-xs text-red-600 underline hover:text-red-700"
            >
              {working === "cancel"
                ? t("billing.cancel.doing")
                : t("billing.cancel.cta")}
            </button>
          )}
        </div>
        {cancelsOnText && <p className="mt-2 text-xs text-gray-600">{t("billing.cancel.scheduledHint")}</p>}
      </section>

      {locations && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
            {t("billing.locations.title")}
          </h2>
          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-600">
              {t("billing.locations.desc", {
                price: empresaPriceText,
                active: sub?.activeLocations ?? 0,
                activeLabel: t((sub?.activeLocations ?? 0) === 1 ? "billing.locations.activeOne" : "billing.locations.activeMany"),
                paid: locations.paid,
              })}
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm text-gray-700">
                <span className="mb-1 block text-xs font-medium text-gray-600">{t("billing.locations.label")}</span>
                <input
                  type="number"
                  min={locations.min}
                  max={1000}
                  step={1}
                  value={locationsValue}
                  onChange={(e) => {
                    const n = Math.floor(Number(e.target.value));
                    setLocationsDraft(Number.isFinite(n) ? n : locations.min);
                  }}
                  className="w-24 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
              </label>
              <button
                onClick={() => setConfirmLocations(true)}
                disabled={
                  working !== null ||
                  !!cancelsOn ||
                  locationsValue === locations.paid ||
                  locationsValue < locations.min ||
                  locationsValue > 1000
                }
                className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {working === "locations" ? t("billing.processing") : t("billing.locations.save")}
              </button>
            </div>
            {locationsValue < locations.min && (
              <p className="mt-2 text-xs text-red-700">{t("billing.locations.min", { min: locations.min })}</p>
            )}
          </div>
        </section>
      )}

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
        {isTrialing && !paysSubscription(sub) && sub?.trialEnd && (
          <p className="mb-3 text-sm text-gray-600">
            {t("billing.trialCheckoutNote", {
              date: new Date(sub.trialEnd).toLocaleDateString(dateLocale),
            })}
          </p>
        )}
        {trialSubscribed && sub?.trialEnd && (
          <p className="mb-3 text-sm text-gray-600">
            {t("billing.trialSubscribedNote", {
              plan: t(`plans.${currentPlan}`),
              date: new Date(sub.trialEnd).toLocaleDateString(dateLocale),
            })}
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans?.map((p: any) => {
            // In trial the highlighted card is the Pro of the trial.
            const isCurrent = p.id === (inTrial ? shownPlan : currentPlan);
            const action = planAction(sub, p.id);
            const isDesired = desiredPlan === p.id && !paysSubscription(sub);
            return (
              <div
                key={p.id}
                className={
                  "rounded-lg border p-5 shadow-sm " +
                  (isCurrent ? "border-violet-300 bg-violet-50/40" : "border-gray-200 bg-white") +
                  (isDesired ? " ring-2 ring-violet-400" : "")
                }
              >
                {isDesired && (
                  <span className="mb-2 inline-block rounded bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                    {t("billing.desiredPlanBadge")}
                  </span>
                )}
                <div className="flex items-baseline justify-between">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {t(`plans.${p.id}`)}
                  </h3>
                  {inTrial && p.id === shownPlan ? (
                    <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                      {t("billing.trialPlanBadge")}
                    </span>
                  ) : (
                    p.id === "pro" && (
                      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        {t("landing.pricing.popular")}
                      </span>
                    )
                  )}
                </div>
                <p className="mt-1 text-2xl font-bold text-gray-900">
                  {t("landing.pricing.price", { amount: p.price / 100 })}
                  <span className="ml-1 text-sm font-normal text-gray-500">
                    {t("landing.pricing.perMonth")} {t("billing.plusVat")}
                  </span>
                </p>
                {p.pricePerLocation && (
                  <p className="text-xs text-gray-500">
                    {t("landing.pricing.perLocation")}
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
                  disabled={action === "current" || working !== null || !!cancelsOn}
                  className={"mt-4 w-full rounded-md px-3 py-2 text-sm font-medium " + (action === "current" ? "bg-gray-100 text-gray-400" : "bg-violet-600 text-white hover:bg-violet-700") + " disabled:opacity-50"}
                >
                  {action === "current"
                    ? t("billing.currentPlanLabel")
                    : working === p.id || working === `check:${p.id}`
                      ? t("billing.processing")
                      : action === "subscribe"
                        ? t("billing.subscribeCurrent")
                        : action === "change"
                          ? t("billing.switchPlan")
                          : t("billing.choosePlan")}
                </button>
              </div>
            );
          })}
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
          {!canBuyAddOns && (
            <p className="mb-3 text-sm text-gray-600">{t("billing.addons.needsPaidPlan")}</p>
          )}
          <AddOnGrid
            addOns={addOns}
            installed={installedAddOns ?? []}
            t={t}
            onPurchase={handlePurchaseAddOn}
            onCancel={handleCancelAddOn}
            working={working}
            canBuy={canBuyAddOns}
          />
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

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={!!pendingPlan}
        title={
          !pendingPlan
            ? ""
            : pendingPlan.blockers.length > 0
              ? t("billing.limits.title", { plan: t(`plans.${pendingPlan.planId}`) })
              : t(pendingPlan.change ? "billing.switchConfirm" : "billing.checkoutConfirm", {
                  plan: t(`plans.${pendingPlan.planId}`),
                })
        }
        description={
          !pendingPlan ? null : pendingPlan.blockers.length > 0 ? (
            <div>
              <p>{t("billing.limits.intro")}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {pendingPlan.blockers.map((b) => (
                  <li key={b.kind}>{b.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            t(pendingPlan.change ? "billing.switchDescription" : "billing.checkoutDescription", {
              price: planPriceText(pendingPlan.planId),
            })
          )
        }
        confirmLabel={
          pendingPlan && pendingPlan.blockers.length > 0
            ? t("billing.limits.go")
            : pendingPlan?.change
              ? t("billing.switchPlan")
              : t("billing.checkoutGo")
        }
        cancelLabel={t("billing.back")}
        loading={!!pendingPlan && working === pendingPlan.planId}
        onCancel={() => setPendingPlan(null)}
        onConfirm={performChoosePlan}
      />

      <ConfirmDialog
        open={confirmCancel}
        title={t("billing.cancel.confirm")}
        description={
          // A paid subscription ends with its period (B3); without one
          // (a trial that never subscribed) read-only starts now.
          paysSubscription(sub) && (sub?.status === "active" || sub?.status === "trialing")
            ? sub?.currentPeriodEnd && !trialSubscribed
              ? t("billing.cancel.description", { date: new Date(sub.currentPeriodEnd).toLocaleDateString(dateLocale) })
              : trialSubscribed && sub?.trialEnd
                ? t("billing.cancel.description", { date: new Date(sub.trialEnd).toLocaleDateString(dateLocale) })
                : t("billing.cancel.descriptionNoDate")
            : t("billing.cancel.descriptionNow")
        }
        confirmLabel={t("billing.cancel.cta")}
        cancelLabel={t("billing.cancel.keep")}
        destructive
        onCancel={() => setConfirmCancel(false)}
        onConfirm={handleCancel}
      />

      <ConfirmDialog
        open={confirmLocations}
        title={t("billing.locations.confirm", { count: locationsValue })}
        description={t("billing.locations.confirmDescription", { price: empresaPriceText })}
        confirmLabel={t("billing.locations.save")}
        cancelLabel={t("billing.back")}
        loading={working === "locations"}
        onCancel={() => setConfirmLocations(false)}
        onConfirm={handleSaveLocations}
      />

      <ConfirmDialog
        open={!!confirmAddOn}
        title={
          confirmAddOn?.action === "purchase"
            ? t("billing.addons.confirmPurchase", {
                name: addOnDisplayName(confirmAddOn.key, addOns, installedAddOns),
                price: confirmAddOnPrice,
              })
            : t("billing.addons.confirmCancel", {
                name: confirmAddOn ? addOnDisplayName(confirmAddOn.key, addOns, installedAddOns) : "",
              })
        }
        description={
          confirmAddOn?.action === "cancel"
            ? t("billing.addons.confirmCancelDescription")
            : t("billing.addons.confirmDescription")
        }
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

/** Add-ons can be bought only on a paid subscription (AddOnsService.purchase). */
function canBuyAddOnsOf(sub: any): boolean {
  if (typeof sub?.canBuyAddOns === "boolean") return sub.canBuyAddOns;
  return sub?.status === "active" && !!sub?.stripeSubscriptionId;
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
    suspended: "bg-red-100 text-red-700",
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
                    {formatSubscriptionAmount(inv.amount, inv.currency)}
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
                        {inv.pending ? t("billing.invoices.pay") : t("billing.invoices.open")}
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
          <span className="text-sm text-gray-500">
            {" "}
            / {ai.cap}{" "}
            {t("billing.aiUsage.capConversations", { count: aiConversationsApprox(ai.cap) })}
          </span>
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
  canBuy,
}: {
  addOns: any[];
  installed: any[];
  t: (key: string, params?: any) => string;
  onPurchase: (key: string) => void;
  onCancel: (key: string) => void;
  working: string | null;
  /** False in trial or without a paid subscription: no "Activar". */
  canBuy: boolean;
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
          ? `${formatSubscriptionAmount(a.monthlyPriceCents, a.currency)} / ${t("billing.addons.perMonth")}`
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
              {!a.metered && !a.purchasable && !isActive && (
                <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                  {t("billing.addons.comingSoon")}
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
              ) : a.metered ? null : !a.purchasable ? (
                <button
                  disabled
                  className="w-full cursor-not-allowed rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-500"
                >
                  {t("billing.addons.comingSoon")}
                </button>
              ) : !canBuy ? (
                <button
                  disabled
                  className="w-full cursor-not-allowed rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-500"
                >
                  {t("billing.addons.withPaidPlan")}
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

// useSearchParams() needs a Suspense boundary for the page to prerender
// (required since Next.js 14.1; 14.0 let it through).
export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingPageContent />
    </Suspense>
  );
}
