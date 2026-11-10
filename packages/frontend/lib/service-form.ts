/**
 * The service drawer (Servicios): what the form holds, how a service from
 * the API fills it, and what it sends back.
 *
 * The API returns a service's price as a string ("25.00": a Decimal column),
 * and the form sent it back as it came, so every edit that did not retype
 * the price was refused. Numbers are kept as typed (strings) and turned
 * into numbers only on save, after checking them against the same limits as
 * the backend (packages/backend/src/services/dto/service-fields.ts). An
 * emptied duration used to become 30 minutes without a word.
 */

export const SERVICE_FORM_LIMITS = {
  durationMin: 5,
  durationMax: 600,
  priceMax: 100_000,
  bufferMax: 240,
  minAdvanceHoursMax: 720,
  maxAdvanceDaysMax: 730,
} as const;

export type ServiceCategoryValue = "hair" | "nails" | "facial" | "massage" | "body" | "other";

export interface ServiceFormState {
  name: string;
  description: string;
  category: ServiceCategoryValue;
  /** Minutes, as typed. */
  duration: string;
  /** Euros, as typed ("25", "25,50", "25.5"). */
  price: string;
  /**
   * Cleanup time after each appointment, in minutes, as typed: the agenda
   * stays blocked that long after it (Service.bufferTime). "0" = none.
   */
  bufferTime: string;
  isActive: boolean;
  isOnlineBookable: boolean;
  requiresApproval: boolean;
  /** Hours of notice an online booking needs, as typed. */
  minAdvanceBooking: string;
  /** Days ahead an online booking may be made, as typed. */
  maxAdvanceBooking: string;
  /** What the client pays to book: nothing, a fixed señal, or a percentage of the price. */
  paymentKind: "none" | "fixed" | "percent";
  /** The señal as typed: euros for "fixed", 1 to 100 for "percent". */
  depositValue: string;
  /** The client may pay the whole service in advance. */
  allowPrepay: boolean;
}

export interface ServicePayload {
  name: string;
  description: string;
  category: ServiceCategoryValue;
  duration: number;
  price: number;
  bufferTime: number;
  currency: "EUR";
  isActive: boolean;
  isOnlineBookable: boolean;
  requiresApproval: boolean;
  minAdvanceBooking: number;
  maxAdvanceBooking: number;
  depositRequired: boolean;
  depositAmount: number | null;
  depositPercentage: number | null;
  allowPrepay: boolean;
}

/** What a field failed on: a key under `services.` in messages/*.json. */
export type ServiceFormError =
  | "name_required"
  | "duration_invalid"
  | "price_invalid"
  | "buffer_invalid"
  | "min_advance_invalid"
  | "max_advance_invalid"
  | "deposit_invalid"
  | "deposit_above_price"
  | "online_price_low";

/** Stripe does not charge under 0,50 EUR: a service cheaper than that cannot ask for money online. */
export const MIN_ONLINE_CHARGE_EUROS = 0.5;

/** A new service: the backend's own defaults (services.service.ts). */
export const EMPTY_SERVICE_FORM: ServiceFormState = {
  name: "",
  description: "",
  category: "other",
  duration: "30",
  price: "0",
  bufferTime: "0",
  isActive: true,
  isOnlineBookable: true,
  requiresApproval: false,
  minAdvanceBooking: "2",
  maxAdvanceBooking: "30",
  paymentKind: "none",
  depositValue: "",
  allowPrepay: false,
};

type ApiService = {
  name: string;
  description?: string | null;
  category: ServiceCategoryValue;
  duration: number | string;
  price: number | string;
  bufferTime?: number | null;
  isActive: boolean;
  isOnlineBookable?: boolean;
  requiresApproval?: boolean;
  minAdvanceBooking?: number | null;
  maxAdvanceBooking?: number | null;
  depositRequired?: boolean | null;
  depositAmount?: number | string | null;
  depositPercentage?: number | string | null;
  allowPrepay?: boolean | null;
};

/** The señal a stored service asks for, as the form shows it. */
function depositToForm(service: ApiService): Pick<ServiceFormState, "paymentKind" | "depositValue"> {
  if (!service.depositRequired) return { paymentKind: "none", depositValue: "" };
  const fixed = Number(service.depositAmount);
  if (Number.isFinite(fixed) && fixed > 0) return { paymentKind: "fixed", depositValue: String(fixed) };
  const percent = Number(service.depositPercentage);
  if (Number.isFinite(percent) && percent > 0) return { paymentKind: "percent", depositValue: String(percent) };
  return { paymentKind: "none", depositValue: "" };
}

/** A service from the API, into the form. */
export function serviceToForm(service: ApiService): ServiceFormState {
  const price = Number(service.price);
  return {
    name: service.name,
    description: service.description ?? "",
    category: service.category,
    duration: String(service.duration ?? ""),
    // "25.00" → "25", "25.50" → "25.5": what the number field shows anyway.
    price: Number.isFinite(price) ? String(price) : "",
    bufferTime: String(service.bufferTime ?? EMPTY_SERVICE_FORM.bufferTime),
    isActive: service.isActive,
    isOnlineBookable: service.isOnlineBookable ?? true,
    requiresApproval: service.requiresApproval ?? false,
    minAdvanceBooking: String(service.minAdvanceBooking ?? EMPTY_SERVICE_FORM.minAdvanceBooking),
    maxAdvanceBooking: String(service.maxAdvanceBooking ?? EMPTY_SERVICE_FORM.maxAdvanceBooking),
    ...depositToForm(service),
    allowPrepay: service.allowPrepay ?? false,
  };
}

/** A whole number from what was typed, or null. "" is not 0. */
function wholeNumber(typed: string): number | null {
  const s = typed.trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

/** Euros from what was typed, comma or point, at most two decimals; or null. */
export function parseEuros(typed: string): number | null {
  const s = typed.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

/** The form, checked and ready to send; or the first field that is wrong. */
export function formToPayload(
  form: ServiceFormState,
): { ok: true; payload: ServicePayload } | { ok: false; error: ServiceFormError } {
  const L = SERVICE_FORM_LIMITS;
  const name = form.name.trim();
  if (!name) return { ok: false, error: "name_required" };

  const duration = wholeNumber(form.duration);
  if (duration === null || duration < L.durationMin || duration > L.durationMax) {
    return { ok: false, error: "duration_invalid" };
  }

  const price = parseEuros(form.price);
  if (price === null || price > L.priceMax) return { ok: false, error: "price_invalid" };

  const bufferTime = wholeNumber(form.bufferTime);
  if (bufferTime === null || bufferTime > L.bufferMax) return { ok: false, error: "buffer_invalid" };

  const minAdvance = wholeNumber(form.minAdvanceBooking);
  if (minAdvance === null || minAdvance > L.minAdvanceHoursMax) {
    return { ok: false, error: "min_advance_invalid" };
  }

  const maxAdvance = wholeNumber(form.maxAdvanceBooking);
  if (maxAdvance === null || maxAdvance < 1 || maxAdvance > L.maxAdvanceDaysMax) {
    return { ok: false, error: "max_advance_invalid" };
  }

  // What she pays to book. Only when the service can be booked online does it matter.
  let depositAmount: number | null = null;
  let depositPercentage: number | null = null;
  if (form.paymentKind === "fixed") {
    const euros = parseEuros(form.depositValue);
    if (euros === null || euros <= 0) return { ok: false, error: "deposit_invalid" };
    if (euros > price) return { ok: false, error: "deposit_above_price" };
    depositAmount = euros;
  } else if (form.paymentKind === "percent") {
    const percent = wholeNumber(form.depositValue);
    if (percent === null || percent < 1 || percent > 100) return { ok: false, error: "deposit_invalid" };
    depositPercentage = percent;
  }
  if ((form.paymentKind !== "none" || form.allowPrepay) && price < MIN_ONLINE_CHARGE_EUROS) {
    return { ok: false, error: "online_price_low" };
  }

  return {
    ok: true,
    payload: {
      name,
      description: form.description,
      category: form.category,
      duration,
      price,
      bufferTime,
      currency: "EUR",
      isActive: form.isActive,
      isOnlineBookable: form.isOnlineBookable,
      requiresApproval: form.requiresApproval,
      minAdvanceBooking: minAdvance,
      maxAdvanceBooking: maxAdvance,
      depositRequired: form.paymentKind !== "none",
      depositAmount,
      depositPercentage,
      allowPrepay: form.allowPrepay,
    },
  };
}
