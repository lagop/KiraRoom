/**
 * What a client may pay online when she books (señal / pago anticipado):
 * the rules, apart from Stripe and the database so they are tested alone
 * (online-payment-policy.spec.ts).
 *
 * Two settings per service decide it, and a third thing, whether the salon
 * can take payments at all:
 *
 *   señal obligatoria (depositRequired + an amount in euros OR a percentage)
 *   pagar todo por adelantado (allowPrepay)
 *
 *   | señal obligatoria | pagar todo | what the client sees                |
 *   | no                | no         | books without paying (as before)    |
 *   | no                | sí         | may pay the whole service, if she wants |
 *   | sí                | no         | must pay the señal to book          |
 *   | sí                | sí         | must pay the señal, or may pay all  |
 *
 * Amounts are in cents, on the price the client sees (tax included).
 * The señal is exempted for a client the caller has recognised as returning
 * (the salon's choice); she is then offered what the service allows without it.
 */

export type OnlinePaymentMode = 'none' | 'optional' | 'deposit' | 'deposit_or_full';

export interface OnlinePaymentService {
  /** The price the client pays, in euros, tax included (what the public page shows). */
  priceEuros: number;
  depositRequired?: boolean | null;
  /** A fixed señal, in euros. */
  depositAmount?: number | string | null;
  /** A señal as a percentage of the price (1 to 100). */
  depositPercentage?: number | string | null;
  allowPrepay?: boolean | null;
}

export interface OnlinePaymentContext {
  /** The salon's Stripe account can take payments now. */
  canCharge: boolean;
  /** This client is exempt from the señal (a returning client, where the salon allows it). */
  exempt?: boolean;
}

export interface OnlinePaymentOffer {
  mode: OnlinePaymentMode;
  /** The price in cents. */
  totalCents: number;
  /** The señal in cents when one is asked; null when not. Never more than the price. */
  depositCents: number | null;
  /** The señal is a condition to book (false for an exempt client, who may still pay). */
  depositRequired: boolean;
  /** She may pay the whole price now. */
  canPayFull: boolean;
}

/** Stripe does not charge less than 0,50 € in euros. */
export const MIN_CHARGE_CENTS = 50;

const NONE = (totalCents: number): OnlinePaymentOffer => ({
  mode: 'none',
  totalCents,
  depositCents: null,
  depositRequired: false,
  canPayFull: false,
});

function positive(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function toCents(euros: number): number {
  return Math.round(euros * 100);
}

/** The señal in cents the service asks for, or null when it asks for none (or is set up wrongly). */
export function depositCentsFor(service: OnlinePaymentService): number | null {
  if (!service.depositRequired) return null;
  const total = toCents(service.priceEuros);
  const fixed = positive(service.depositAmount);
  const percentage = positive(service.depositPercentage);
  let cents: number | null = null;
  if (fixed !== null) cents = toCents(fixed);
  else if (percentage !== null) cents = Math.round((total * Math.min(percentage, 100)) / 100);
  if (cents === null || cents <= 0) return null;
  return Math.min(Math.max(cents, MIN_CHARGE_CENTS), total);
}

export function onlinePaymentOffer(service: OnlinePaymentService, ctx: OnlinePaymentContext): OnlinePaymentOffer {
  const totalCents = toCents(service.priceEuros);
  // Nothing to pay online when the salon cannot charge, or the service is free or too cheap to charge.
  if (!ctx.canCharge || totalCents < MIN_CHARGE_CENTS) return NONE(totalCents);

  const deposit = depositCentsFor(service);
  const depositRequired = deposit !== null && !ctx.exempt;
  const canPayFull = service.allowPrepay === true;
  if (!depositRequired && !canPayFull) return NONE(totalCents);

  return {
    mode: depositRequired ? (canPayFull ? 'deposit_or_full' : 'deposit') : 'optional',
    totalCents,
    // The señal is shown even when this client is exempt from it only if she must pay it.
    depositCents: depositRequired ? deposit : null,
    depositRequired,
    canPayFull,
  };
}

/** What the client pays now, once the offer and her choice are known. */
export interface OnlinePaymentChoice {
  kind: 'deposit' | 'full';
  cents: number;
}

/**
 * What the client is made to pay for this booking, or null when she books
 * without paying. `requested` is what she picked on the page; the salon's
 * rules decide what is allowed:
 *
 *   mode none             nothing, whatever she asked
 *   mode optional         all, only if she asked for it
 *   mode deposit          the señal (asking for all is not allowed here)
 *   mode deposit_or_full  the señal, or all if she asked for it
 */
export function chooseOnlinePayment(
  offer: OnlinePaymentOffer,
  requested?: 'deposit' | 'full' | null,
): OnlinePaymentChoice | null {
  switch (offer.mode) {
    case 'optional':
      return requested === 'full' ? { kind: 'full', cents: offer.totalCents } : null;
    case 'deposit':
      return offer.depositCents ? { kind: 'deposit', cents: offer.depositCents } : null;
    case 'deposit_or_full':
      if (requested === 'full') return { kind: 'full', cents: offer.totalCents };
      return offer.depositCents ? { kind: 'deposit', cents: offer.depositCents } : null;
    default:
      return null;
  }
}

/**
 * Why a service's online-payment settings cannot be saved, in Spanish; null
 * when they can. A señal is exactly one of a fixed amount or a percentage, it
 * cannot be more than the price, and a service has to cost enough to be charged.
 */
export function onlinePaymentSettingsProblem(s: {
  price: number | string;
  depositRequired?: boolean | null;
  depositAmount?: number | string | null;
  depositPercentage?: number | string | null;
  allowPrepay?: boolean | null;
}): string | null {
  const price = Number(s.price);
  const fixed = positive(s.depositAmount);
  const percentage = positive(s.depositPercentage);

  if (s.depositRequired) {
    if (fixed === null && percentage === null) {
      return 'Indica la señal: un importe fijo o un porcentaje del precio.';
    }
    if (fixed !== null && percentage !== null) {
      return 'La señal es un importe fijo o un porcentaje, no las dos cosas.';
    }
    if (percentage !== null && percentage > 100) return 'La señal no puede pasar del 100 % del precio.';
    if (fixed !== null && fixed > price) return 'La señal no puede ser mayor que el precio del servicio.';
  }
  if ((s.depositRequired || s.allowPrepay) && toCents(price) < MIN_CHARGE_CENTS) {
    return 'Para cobrar online, el servicio tiene que costar al menos 0,50 €.';
  }
  return null;
}
