/**
 * The loyalty page's reward form and points adjustment, as pure functions
 * (tested in loyalty-rewards.spec.ts). The page (app/dashboard/loyalty)
 * draws them.
 *
 *   - A discount reward is a percent OR a fixed amount, above zero, never
 *     both (the API refuses the rest: loyalty.dto.ts discountValueProblem).
 *   - A limit of uses and an expiry date are optional: empty means none.
 *     The expiry is the end of that day, in the salon's browser.
 *   - A manual adjustment is an amount, a sign (add or take) and a reason.
 */
import type { LoyaltyReward, LoyaltyRewardInput } from "./api";

export type RewardType = LoyaltyRewardInput["type"];
export type DiscountKind = "percent" | "amount";

/** What the form holds: text as typed, turned into the API's body by rewardPayload. */
export interface RewardForm {
  name: string;
  type: RewardType;
  pointsCost: string;
  discountKind: DiscountKind;
  /** Whole percent, 1-100. */
  percent: string;
  /** Euros, "5" or "5,50". */
  euros: string;
  freeServiceId: string;
  isActive: boolean;
  /** Empty: no limit. */
  maxRedemptions: string;
  /** "YYYY-MM-DD"; empty: it never expires. */
  expiresOn: string;
}

export const EMPTY_REWARD_FORM: RewardForm = {
  name: "",
  type: "discount",
  pointsCost: "100",
  discountKind: "percent",
  percent: "10",
  euros: "",
  freeServiceId: "",
  isActive: true,
  maxRedemptions: "",
  expiresOn: "",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** A date as the form's day ("YYYY-MM-DD"), in local time. */
export function dayOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The form for an existing reward. */
export function rewardFormOf(r: LoyaltyReward): RewardForm {
  const amount = r.discountAmount && r.discountAmount > 0 ? r.discountAmount : 0;
  return {
    name: r.name,
    type: r.type,
    pointsCost: String(r.pointsCost),
    discountKind: amount > 0 && !(r.discountPercent && r.discountPercent > 0) ? "amount" : "percent",
    percent: r.discountPercent && r.discountPercent > 0 ? String(r.discountPercent) : "",
    euros: amount > 0 ? (amount / 100).toFixed(2).replace(".", ",") : "",
    freeServiceId: r.freeServiceId ?? "",
    isActive: r.isActive,
    maxRedemptions: r.maxRedemptions ? String(r.maxRedemptions) : "",
    expiresOn: dayOf(r.expiresAt),
  };
}

/** Euros as typed ("5", "5,50", "5.5") in cents, or NaN. */
export function centsOf(euros: string): number {
  const t = euros.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}

/**
 * The body for POST/PUT /loyalty/rewards, or the reason the form is not
 * ready (in Spanish, shown as is). `usedTimes`: an edit cannot set a limit
 * below what was redeemed already.
 */
export function rewardPayload(
  f: RewardForm,
  usedTimes = 0,
): { ok: true; body: LoyaltyRewardInput } | { ok: false; error: string } {
  const name = f.name.trim();
  if (!name) return { ok: false, error: "Ponle un nombre a la recompensa." };
  const pointsCost = Number(f.pointsCost);
  if (!Number.isInteger(pointsCost) || pointsCost < 1) {
    return { ok: false, error: "Los puntos que cuesta deben ser un número entero mayor que 0." };
  }

  let discountPercent: number | null = null;
  let discountAmount: number | null = null;
  if (f.type === "discount") {
    if (f.discountKind === "percent") {
      const p = Number(f.percent);
      if (!Number.isInteger(p) || p < 1 || p > 100) {
        return { ok: false, error: "El porcentaje de descuento debe estar entre 1 y 100." };
      }
      discountPercent = p;
    } else {
      const c = centsOf(f.euros);
      if (!(c > 0)) return { ok: false, error: "Indica un importe de descuento mayor que 0 (p. ej. 5,00)." };
      discountAmount = c;
    }
  }
  if (f.type === "free_service" && !f.freeServiceId) {
    return { ok: false, error: "Elige el servicio que regala la recompensa." };
  }

  let maxRedemptions: number | null = null;
  if (f.maxRedemptions.trim()) {
    const m = Number(f.maxRedemptions);
    if (!Number.isInteger(m) || m < 1) return { ok: false, error: "El límite de canjes debe ser un número entero mayor que 0." };
    if (m < usedTimes) return { ok: false, error: `Ya se ha canjeado ${usedTimes} veces: el límite no puede ser menor.` };
    maxRedemptions = m;
  }

  let expiresAt: string | null = null;
  if (f.expiresOn) {
    const [y, mo, d] = f.expiresOn.split("-").map(Number);
    // The whole day counts: it expires at its end.
    const end = new Date(y, (mo ?? 1) - 1, d ?? 1, 23, 59, 59, 999);
    if (Number.isNaN(end.getTime())) return { ok: false, error: "La fecha de caducidad no es válida." };
    expiresAt = end.toISOString();
  }

  return {
    ok: true,
    body: {
      name,
      type: f.type,
      pointsCost,
      // Both always sent, so an edit from percent to amount clears the other.
      discountPercent: discountPercent ?? 0,
      discountAmount: discountAmount ?? 0,
      freeServiceId: f.type === "free_service" ? f.freeServiceId : null,
      isActive: f.isActive,
      maxRedemptions,
      expiresAt,
    },
  };
}

/** The manual adjustment's points, signed, or why it cannot be sent. */
export function adjustmentOf(
  amount: string,
  sign: "add" | "take",
  reason: string,
  balance: number,
): { ok: true; points: number; reason: string } | { ok: false; error: string } {
  const n = Number(amount.trim());
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: "Indica cuántos puntos: un número entero mayor que 0." };
  if (n > 1_000_000) return { ok: false, error: "Como mucho 1.000.000 de puntos de una vez." };
  const why = reason.trim();
  if (!why) return { ok: false, error: "Indica el motivo: queda en su historial." };
  if (why.length > 300) return { ok: false, error: "El motivo admite como mucho 300 caracteres." };
  if (sign === "take" && n > balance) return { ok: false, error: `Solo tiene ${balance} puntos: no se le pueden quitar ${n}.` };
  return { ok: true, points: sign === "add" ? n : -n, reason: why };
}
