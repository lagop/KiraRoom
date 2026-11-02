/**
 * What each plan card on the billing page offers, from the salon's current
 * subscription. Pure, tested in billing-plan.spec.ts.
 *
 * - "current": its plan, nothing to do.
 * - "subscribe": its plan while in the free trial: it can pay for it now
 *   (the first charge waits for the trial to end, see the backend's
 *   checkoutTrialEnd). Also its plan once cancelled: the plan it had is no
 *   longer paid, so it can contract it again (it used to be a disabled
 *   "Tu plan actual", and a cancelled salon could not pay for its plan).
 * - "checkout": another plan, through Stripe Checkout (no subscription yet).
 * - "change": another plan on the subscription it already pays; a checkout
 *   there would start a second subscription, billed on top.
 */
export type PlanAction = "current" | "subscribe" | "checkout" | "change";

export interface BillingSubscription {
  plan?: string | null;
  status?: string | null;
  stripeSubscriptionId?: string | null;
  cancelAtPeriodEnd?: boolean | null;
  cancelAt?: string | null;
  maxLocations?: number | null;
  activeLocations?: number | null;
}

export function paysSubscription(sub: BillingSubscription | null | undefined): boolean {
  return !!sub?.stripeSubscriptionId && sub.status !== "cancelled";
}

export function planAction(sub: BillingSubscription | null | undefined, planId: string): PlanAction {
  const current = (sub?.plan || "esencial") === planId;
  if (paysSubscription(sub)) return current ? "current" : "change";
  if (current) {
    return sub?.status === "trialing" || sub?.status === "cancelled" ? "subscribe" : "current";
  }
  return "checkout";
}

/**
 * When a subscription cancelled at the end of its paid period ends (ISO
 * date), or null when it renews or has already ended. Until then the salon
 * keeps everything and can undo the cancellation.
 */
export function scheduledCancellation(sub: BillingSubscription | null | undefined): string | null {
  if (!sub || sub.status === "cancelled" || !sub.cancelAtPeriodEnd || !sub.cancelAt) return null;
  return sub.cancelAt;
}

/**
 * Subscribed during the free trial: it keeps the trial (Pro) until the
 * trial ends, when the first charge comes.
 */
export function subscribedInTrial(sub: BillingSubscription | null | undefined): boolean {
  return sub?.status === "trialing" && paysSubscription(sub);
}

/**
 * Empresa pays one per location: how many the subscription pays for, and
 * the fewest it can pay for (the locations open now). Null outside a paid
 * Empresa subscription.
 */
export function empresaLocations(
  sub: BillingSubscription | null | undefined,
): { paid: number; min: number } | null {
  if (sub?.plan !== "empresa" || !paysSubscription(sub)) return null;
  const paid = Math.max(1, sub.maxLocations ?? 1);
  const min = Math.max(1, sub.activeLocations ?? 1);
  return { paid, min };
}

/**
 * The name an add-on is shown with: the catalogue's ("Pack de 1.000 mensajes
 * de IA"), or the installed row's, never the internal key (ai_messages_1000)
 * unless nothing else is known.
 */
export function addOnDisplayName(
  key: string,
  catalog: Array<{ key?: string; name?: string } | null | undefined> | null | undefined,
  installed?: Array<{ addOnKey?: string; addOn?: { key?: string; name?: string } | null } | null | undefined> | null,
): string {
  const fromCatalog = catalog?.find((a) => a?.key === key)?.name;
  if (fromCatalog) return fromCatalog;
  const fromInstalled = installed?.find((i) => (i?.addOn?.key ?? i?.addOnKey) === key)?.addOn?.name;
  return fromInstalled || key;
}

/** Cents as Spanish money in the invoice's currency: 4900 -> "49,00 €". */
export function formatSubscriptionAmount(cents: number, currency?: string | null): string {
  const code = (currency || "eur").toUpperCase();
  try {
    return new Intl.NumberFormat("es-ES", { style: "currency", currency: code }).format((cents || 0) / 100);
  } catch {
    return `${((cents || 0) / 100).toFixed(2).replace(".", ",")} ${code}`;
  }
}
