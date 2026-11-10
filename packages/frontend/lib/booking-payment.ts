/**
 * Paying online when a client books (señal / pago anticipado): what the
 * booking page and the widget show, what they send, and what they do with
 * the answer. Pure, so it is tested without the browser
 * (booking-payment.spec.ts).
 *
 * The server decides everything (who pays, how much, whether she is exempt);
 * this only shows what the service offers and sends her choice. The amounts
 * shown are the offer's, in cents, on the tax-included price.
 */

export interface ServiceOnlinePayment {
  mode: "none" | "optional" | "deposit" | "deposit_or_full";
  totalCents: number;
  depositCents: number | null;
  depositRequired: boolean;
  canPayFull: boolean;
}

/** What she picks: the señal, all of it, or to pay at the salon (only where paying is optional). */
export type PaymentChoice = "deposit" | "full" | "later";

export interface PaymentOption {
  value: PaymentChoice;
  /** What it costs now (cents); null for "later". */
  cents: number | null;
}

export interface PaymentOptions {
  /** She cannot book without paying. */
  required: boolean;
  options: PaymentOption[];
  defaultChoice: PaymentChoice;
}

/** "15,00 €" from cents, as the rest of the app writes euros. */
export function euros(cents: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(cents / 100);
}

/** The choices the service gives her, or null when it asks nothing online. */
export function paymentOptions(offer: ServiceOnlinePayment | null | undefined): PaymentOptions | null {
  if (!offer) return null;
  switch (offer.mode) {
    case "deposit":
      return offer.depositCents
        ? { required: true, options: [{ value: "deposit", cents: offer.depositCents }], defaultChoice: "deposit" }
        : null;
    case "deposit_or_full":
      return offer.depositCents
        ? {
            required: true,
            options: [
              { value: "deposit", cents: offer.depositCents },
              { value: "full", cents: offer.totalCents },
            ],
            defaultChoice: "deposit",
          }
        : null;
    case "optional":
      return {
        required: false,
        options: [
          { value: "later", cents: null },
          { value: "full", cents: offer.totalCents },
        ],
        defaultChoice: "later",
      };
    default:
      return null;
  }
}

/** The choice that is valid for this offer: hers if the service offers it, else the default. */
export function effectiveChoice(offer: ServiceOnlinePayment | null | undefined, choice: PaymentChoice | null): PaymentChoice | null {
  const opts = paymentOptions(offer);
  if (!opts) return null;
  return choice && opts.options.some((o) => o.value === choice) ? choice : opts.defaultChoice;
}

/** What goes in the booking's `payment` field: nothing when she pays at the salon or nothing is asked. */
export function paymentToSend(offer: ServiceOnlinePayment | null | undefined, choice: PaymentChoice | null): "deposit" | "full" | undefined {
  const picked = effectiveChoice(offer, choice);
  return picked === "deposit" || picked === "full" ? picked : undefined;
}

/** The cents she pays now (cents), or null when she pays nothing now. */
export function amountDueNow(offer: ServiceOnlinePayment | null | undefined, choice: PaymentChoice | null): number | null {
  const opts = paymentOptions(offer);
  const picked = effectiveChoice(offer, choice);
  return opts?.options.find((o) => o.value === picked)?.cents ?? null;
}

/** The answer to the booking says she has to pay to confirm it. */
export interface PaymentRequiredAnswer {
  payment: {
    required: true;
    kind: "deposit" | "full";
    amountCents: number;
    currency: string;
    checkoutUrl: string;
    holdUntil: string;
  };
}

export function bookingNeedsPayment(answer: unknown): answer is PaymentRequiredAnswer {
  const p = (answer as { payment?: { required?: unknown; checkoutUrl?: unknown } } | null)?.payment;
  return !!p && p.required === true && typeof p.checkoutUrl === "string";
}

/** Only Stripe's own pages may be opened as the payment page. */
export function safeCheckoutUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com")) ? url : null;
  } catch {
    return null;
  }
}

/** Minutes the server holds the slot for her (HOLD_MINUTES less its grace, as she is told). */
export const HOLD_MINUTES_SHOWN = 30;

/** "?pago=ok" / "?pago=cancelado" on the page Stripe sends her back to. */
export function paymentReturn(search: string): "ok" | "cancelado" | null {
  const v = new URLSearchParams(search).get("pago");
  return v === "ok" || v === "cancelado" ? v : null;
}

/** The texts of the payment step, shared by the salon page and the widget (like BOOKING_CHOICE_TEXT). */
export const BOOKING_PAYMENT_TEXT = {
  title: "Pago online",
  depositNote: (amount: string) =>
    `Este servicio pide una señal de ${amount} para confirmar tu reserva; el resto lo pagas en el salón. Si ya has venido antes, puede que no haga falta.`,
  optionalNote: "Puedes pagar ya el servicio completo, o hacerlo en el salón.",
  choiceDeposit: (amount: string) => `Pagar solo la señal (${amount})`,
  choiceFull: (amount: string) => `Pagar el servicio completo (${amount})`,
  choiceLater: "Pagar en el salón",
  holdNote: `Te guardamos el hueco ${HOLD_MINUTES_SHOWN} minutos mientras pagas.`,
  payButton: (amount: string) => `Reservar y pagar ${amount}`,
  redirecting: "Te llevamos al pago seguro…",
  payFailed: "No se ha podido abrir el pago. Inténtalo de nuevo.",
} as const;
