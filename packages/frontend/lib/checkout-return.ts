/**
 * What the billing page says when the owner comes back from a plan
 * checkout (B15). Stripe adds the session id to the return URL and the page
 * asks the backend about that session (GET
 * /payments/subscription/checkout-session/:id). Pure, tested in
 * checkout-return.spec.ts.
 *
 * In the free trial Stripe only saves the card (nothing is charged until
 * the trial ends): the page said "Pago recibido" all the same.
 */
import type { CheckoutSessionStatus } from "./api";

export type CheckoutReturnMessage =
  | { kind: "cardSaved"; firstChargeAt: string }
  | { kind: "paid" }
  | { kind: "pending" };

export function checkoutReturnMessage(session: CheckoutSessionStatus | null): CheckoutReturnMessage {
  if (!session || session.status !== "complete") return { kind: "pending" };
  if (session.firstChargeAt && session.paymentStatus !== "paid") {
    return { kind: "cardSaved", firstChargeAt: session.firstChargeAt };
  }
  return { kind: "paid" };
}

/** Keep asking while Stripe has completed the session but the webhook has not applied it yet. */
export function shouldKeepPolling(session: CheckoutSessionStatus | null, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) return false;
  if (!session) return true;
  if (session.status === "expired") return false;
  return !session.applied;
}
