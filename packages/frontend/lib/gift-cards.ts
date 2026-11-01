/**
 * Gift cards ("Tarjetas regalo") as the panel shows them.
 *
 * The server sends each card's `status` (spent and expired are derived from
 * the balance and the expiry, not stored) and `expiresOn`, the salon
 * calendar day the card is valid until.
 */
import {
  PLAN_LABELS_ES,
  PLAN_PRICES,
  minPlanFor,
} from "@kira/shared";

export type GiftCardStatus = "active" | "inactive" | "expired" | "spent";

export const GIFT_CARD_STATUS_LABEL: Record<GiftCardStatus, string> = {
  active: "Activa",
  inactive: "Inactiva",
  expired: "Caducada",
  spent: "Agotada",
};

export const GIFT_CARD_MOVEMENT_LABEL: Record<string, string> = {
  created: "Emitida",
  applied: "Canje",
  refunded: "Devolución",
  expired: "Caducada",
};

/** How long a card is valid when the salon does not change it (as the server). */
export const DEFAULT_GIFT_CARD_VALIDITY_YEARS = 2;

/** A card's status, from the server's or worked out the same way for an older response. */
export function giftCardStatusOf(
  card: {
    status?: GiftCardStatus;
    isActive: boolean;
    currentBalance: number;
    expiresAt: string | null;
  },
  now: Date = new Date(),
): GiftCardStatus {
  if (card.status) return card.status;
  if (card.currentBalance <= 0) return "spent";
  if (card.expiresAt && new Date(card.expiresAt).getTime() < now.getTime()) return "expired";
  if (!card.isActive) return "inactive";
  return "active";
}

/** Only a working card can be switched off: the button is hidden on the rest. */
export function canDeactivate(status: GiftCardStatus): boolean {
  return status === "active";
}

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today on this device, "YYYY-MM-DD" (the date input's `min`). */
export function todayDay(now: Date = new Date()): string {
  return isoDay(now);
}

/** The expiry the create form starts with: today plus the default validity. */
export function defaultGiftCardExpiry(now: Date = new Date()): string {
  return isoDay(
    new Date(now.getFullYear() + DEFAULT_GIFT_CARD_VALIDITY_YEARS, now.getMonth(), now.getDate()),
  );
}

/** "2026-12-31" -> "31/12/2026". */
export function formatDay(day: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

/** 2550 -> "25,50 €" */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(
    (cents ?? 0) / 100,
  );
}

/** "Incluidas desde el plan Pro (79 €/mes)", from the shared plan catalogue. */
export function giftCardsPlanNote(): string {
  const plan = minPlanFor("gift_cards");
  if (!plan) return "Disponible como complemento.";
  return `Incluidas desde el plan ${PLAN_LABELS_ES[plan]} (${PLAN_PRICES[plan]} €/mes).`;
}

/** What the panel says after creating a card, about the email. */
export function createdEmailNote(emailSent: boolean | null | undefined, email?: string): string | undefined {
  if (emailSent === true) return `Enviada por email a ${email}.`;
  if (emailSent === false) {
    return "No se pudo enviar el email. Comparte el código con la persona que la recibe.";
  }
  return undefined;
}
