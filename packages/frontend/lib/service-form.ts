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
  isActive: boolean;
  isOnlineBookable: boolean;
  requiresApproval: boolean;
  /** Hours of notice an online booking needs, as typed. */
  minAdvanceBooking: string;
  /** Days ahead an online booking may be made, as typed. */
  maxAdvanceBooking: string;
}

export interface ServicePayload {
  name: string;
  description: string;
  category: ServiceCategoryValue;
  duration: number;
  price: number;
  currency: "EUR";
  isActive: boolean;
  isOnlineBookable: boolean;
  requiresApproval: boolean;
  minAdvanceBooking: number;
  maxAdvanceBooking: number;
}

/** What a field failed on: a key under `services.` in messages/*.json. */
export type ServiceFormError =
  | "name_required"
  | "duration_invalid"
  | "price_invalid"
  | "min_advance_invalid"
  | "max_advance_invalid";

/** A new service: the backend's own defaults (services.service.ts). */
export const EMPTY_SERVICE_FORM: ServiceFormState = {
  name: "",
  description: "",
  category: "other",
  duration: "30",
  price: "0",
  isActive: true,
  isOnlineBookable: true,
  requiresApproval: false,
  minAdvanceBooking: "2",
  maxAdvanceBooking: "30",
};

type ApiService = {
  name: string;
  description?: string | null;
  category: ServiceCategoryValue;
  duration: number | string;
  price: number | string;
  isActive: boolean;
  isOnlineBookable?: boolean;
  requiresApproval?: boolean;
  minAdvanceBooking?: number | null;
  maxAdvanceBooking?: number | null;
};

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
    isActive: service.isActive,
    isOnlineBookable: service.isOnlineBookable ?? true,
    requiresApproval: service.requiresApproval ?? false,
    minAdvanceBooking: String(service.minAdvanceBooking ?? EMPTY_SERVICE_FORM.minAdvanceBooking),
    maxAdvanceBooking: String(service.maxAdvanceBooking ?? EMPTY_SERVICE_FORM.maxAdvanceBooking),
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

  const minAdvance = wholeNumber(form.minAdvanceBooking);
  if (minAdvance === null || minAdvance > L.minAdvanceHoursMax) {
    return { ok: false, error: "min_advance_invalid" };
  }

  const maxAdvance = wholeNumber(form.maxAdvanceBooking);
  if (maxAdvance === null || maxAdvance < 1 || maxAdvance > L.maxAdvanceDaysMax) {
    return { ok: false, error: "max_advance_invalid" };
  }

  return {
    ok: true,
    payload: {
      name,
      description: form.description,
      category: form.category,
      duration,
      price,
      currency: "EUR",
      isActive: form.isActive,
      isOnlineBookable: form.isOnlineBookable,
      requiresApproval: form.requiresApproval,
      minAdvanceBooking: minAdvance,
      maxAdvanceBooking: maxAdvance,
    },
  };
}
