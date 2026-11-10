/**
 * What the panel says about a booking that is paid online (señal / pago
 * anticipado): still waiting for the client's payment, or paid and what it
 * was. Pure, so it is tested without the browser (online-booking-state.spec.ts).
 *
 * Amounts are cents, as the appointment carries them (`totalAmount`,
 * `amountPaid`, `depositAmount`).
 */

/** The appointment fields this reads; any appointment shape with some of them will do. */
export interface OnlineBookingFields {
  onlinePaymentKind?: string | null;
  paymentHoldUntil?: string | null;
  depositPaid?: boolean | null;
  depositAmount?: number | string | null;
  totalAmount?: number | string | null;
  amountPaid?: number | string | null;
}

const fields = (a: unknown): OnlineBookingFields => (a ?? {}) as OnlineBookingFields;
const cents = (v: unknown): number => {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Held for her online payment: not a booking yet; it confirms itself when she pays. */
export function isAwaitingOnlinePayment(appointment: unknown): boolean {
  const a = fields(appointment);
  return !!a.paymentHoldUntil && !a.depositPaid;
}

/** "HH:mm" until when the slot is held, in the visitor's clock, or null. */
export function holdUntilLabel(appointment: unknown, locale = "es-ES"): string | null {
  const iso = fields(appointment).paymentHoldUntil;
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** What the client paid online and the salon still holds, in cents (0: nothing, or never online). */
export function paidOnlineCents(appointment: unknown): number {
  const a = fields(appointment);
  if (!a.onlinePaymentKind || a.paymentHoldUntil) return 0;
  const paid = cents(a.amountPaid);
  const online = a.onlinePaymentKind === "full" ? cents(a.totalAmount) : cents(a.depositAmount);
  return Math.min(paid, online || paid);
}

/**
 * What a cancellation says about the money it should have given back: nothing
 * when there was none (or it went back), a warning when Stripe could not return
 * some of it and the salon has to. `result` is the cancel response.
 */
export function onlineRefundNotice(result: unknown): { title: string; description: string; variant?: "destructive" } | null {
  const r = (result as { onlineRefund?: { refundedCents?: number; failed?: number } } | null | undefined)?.onlineRefund;
  if (!r) return null;
  const failed = Number(r.failed ?? 0);
  if (failed > 0) {
    return {
      title: "No se pudo devolver el pago online",
      description: "La cita se ha cancelado, pero Stripe no ha podido devolver el dinero a la clienta. Devuélvelo a mano desde Pagos.",
      variant: "destructive",
    };
  }
  const cents = cents0(r.refundedCents);
  if (cents <= 0) return null;
  return {
    title: "Pago online devuelto",
    description: `Se han devuelto ${(cents / 100).toFixed(2).replace(".", ",")} € a la clienta (puede tardar unos días en verse en su tarjeta).`,
  };
}
const cents0 = (v: unknown): number => {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** What was paid online: "señal" or "servicio completo", for a sentence. */
export function onlineKindLabel(appointment: unknown): string {
  return fields(appointment).onlinePaymentKind === "full" ? "el servicio completo" : "la señal";
}
