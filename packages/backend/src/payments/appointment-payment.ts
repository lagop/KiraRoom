import { ConflictException } from "@nestjs/common";
import { AppointmentStatus, PaymentStatus } from "@prisma/client";
import { bookedService } from "../appointments/appointment-snapshot";

/**
 * How an appointment learns it was paid. Money is in **cents**, the unit of
 * `appointments.totalAmount`, `appointments.amountPaid` and `payments.amount`
 * (see analytics-metrics.ts).
 *
 * The till used to record its payment with no appointment on it and then
 * mark the appointment paid with a second, separate call that took any
 * amount: the appointment never knew which payment paid it, a failure
 * between the two calls left a sale with no paid appointment (or the
 * reverse), and a cancelled or no-show visit could be charged.
 */

/** The fields of an appointment this module reads. */
export interface PayableAppointment {
  id: string;
  status: AppointmentStatus | string;
  paymentStatus: PaymentStatus | string;
  amountPaid: unknown;
  totalAmount: unknown;
  service?: { price: unknown } | null;
  /** The price it was booked at (appointment-snapshot.ts), euros. */
  servicePrice?: unknown;
  /**
   * The visit's total in money (tax included: what its invoice comes to),
   * when it is not its catalogue total: a salon whose prices are the base
   * (appointment-charge.ts). Left out: the catalogue total is the money.
   */
  chargeTotalCents?: number;
}

/**
 * What the visit costs in the salon's CATALOGUE terms, in cents: its stored
 * total, else its service's list price (euros, hence x 100). Money is
 * appointmentChargeCents (appointment-charge.ts explains the two bases).
 */
export function appointmentTotalCents(apt: Pick<PayableAppointment, "totalAmount" | "service" | "servicePrice">): number {
  const total = Number(apt.totalAmount ?? 0);
  if (total > 0) return Math.round(total);
  return Math.round(Number(bookedService(apt)?.price ?? 0) * 100);
}

/** What the visit costs in money (tax included), in cents: what its invoice comes to. */
export function appointmentChargeCents(
  apt: Pick<PayableAppointment, "totalAmount" | "service" | "chargeTotalCents">,
): number {
  return typeof apt.chargeTotalCents === "number" ? apt.chargeTotalCents : appointmentTotalCents(apt);
}

/** What is still to be paid, in money cents (amountPaid is money). */
export function appointmentOwedCents(apt: PayableAppointment): number {
  return Math.max(0, appointmentChargeCents(apt) - Math.round(Number(apt.amountPaid ?? 0)));
}

/**
 * 409 for a visit that did not happen: cancelled or no-show. A no-show fee,
 * if the salon charges one, is a sale of its own, not the visit.
 */
export function assertVisitChargeable(apt: Pick<PayableAppointment, "id" | "status">): void {
  if (apt.status === AppointmentStatus.cancelled) {
    throw new ConflictException({
      code: "APPOINTMENT_NOT_CHARGEABLE",
      message: "Esta cita está cancelada: no se puede cobrar.",
      appointmentId: apt.id,
    });
  }
  if (apt.status === AppointmentStatus.no_show) {
    throw new ConflictException({
      code: "APPOINTMENT_NOT_CHARGEABLE",
      message: "Esta cita está marcada como no presentada: no se puede cobrar.",
      appointmentId: apt.id,
    });
  }
}

/** 409 unless the till can charge the appointment: it happened and is not paid yet. */
export function assertChargeable(apt: PayableAppointment): void {
  assertVisitChargeable(apt);
  if (apt.paymentStatus === PaymentStatus.paid) {
    throw new ConflictException({
      code: "APPOINTMENT_ALREADY_PAID",
      message: "Esta cita ya está cobrada.",
      appointmentId: apt.id,
    });
  }
}

/** One payment row of a ticket, before it is written. */
export interface TenderSplit<A> {
  method: string;
  amount: number;
  /** The appointment this part pays for, or null (products, change...). */
  appointment: A | null;
}

export interface AppointmentShare<A> {
  appointment: A;
  /** Covered by the loyalty reward, in cents. */
  fromDiscount: number;
  /** Covered by money, in cents. */
  fromMoney: number;
  /** The methods that paid it. */
  methods: string[];
}

/**
 * Splits a ticket over the appointments it pays for. The loyalty discount
 * covers the appointments first, in the order given; then each tender
 * (cash, card...) pays what is still owed, in order. Nothing is allocated
 * past what an appointment owes: what is left over is a payment of the
 * ticket with no appointment (products added to the cart, or the cashier's
 * rounding). An appointment the ticket does not cover in full is left
 * partly paid, never marked paid.
 *
 * `manualDiscounts` (appointment id -> cents) are discounts given at the
 * till (pos-discounts.ts): unlike the loyalty reward they lower what the
 * visit costs, so they come off what it owes before anything is split.
 */
export function splitTicket<A extends PayableAppointment>(
  appointments: A[],
  tenders: { method: string; amount: number }[],
  discountCents: number,
  manualDiscounts?: ReadonlyMap<string, number>,
): { rows: TenderSplit<A>[]; shares: AppointmentShare<A>[] } {
  const owedOf = (a: A) => Math.max(0, appointmentOwedCents(a) - (manualDiscounts?.get(a.id) ?? 0));
  let discountLeft = Math.max(0, discountCents);
  const shares: AppointmentShare<A>[] = appointments.map((appointment) => {
    const owed = owedOf(appointment);
    const fromDiscount = Math.min(owed, discountLeft);
    discountLeft -= fromDiscount;
    return { appointment, fromDiscount, fromMoney: 0, methods: [] };
  });

  const rows: TenderSplit<A>[] = [];
  for (const tender of tenders) {
    let left = tender.amount;
    for (const share of shares) {
      const need = owedOf(share.appointment) - share.fromDiscount - share.fromMoney;
      const take = Math.min(left, need);
      if (take <= 0) continue;
      rows.push({ method: tender.method, amount: take, appointment: share.appointment });
      share.fromMoney += take;
      if (!share.methods.includes(tender.method)) share.methods.push(tender.method);
      left -= take;
    }
    // What no appointment takes stays one row of the ticket, as before; a
    // ticket paid in full with points still records its (zero) tender.
    if (left > 0 || tender.amount === 0) {
      rows.push({ method: tender.method, amount: left, appointment: null });
    }
  }
  return { rows, shares };
}

/** The method an appointment was paid with, for its `paymentMethod` column. */
export function shareMethod(share: AppointmentShare<unknown>): string | null {
  if (share.methods.length === 1) return share.methods[0];
  if (share.methods.length > 1) return "mixed";
  return share.fromDiscount > 0 ? "loyalty_points" : null;
}

/**
 * Adds a ticket's share to the appointment, inside the ticket's
 * transaction: the paid amount grows and the appointment is paid once it
 * covers the total. Written over the amount and status just read, so two
 * tills charging the same visit at once cannot both succeed: the second
 * gets a 409 and its whole ticket is rolled back.
 *
 * The appointment's own status is not touched here. Completing a visit
 * checks its consent forms and issues its invoice, notices and points;
 * that is the agenda's job (AppointmentsService.changeStatus), and the
 * points follow once both are true (LoyaltyService.settleAppointment).
 *
 * `discount`: a discount given at the till on this visit. The visit then
 * costs that much less, in the same write: its total and price go down (so
 * commissions, which are a percent of the total, follow what was charged)
 * and `discount` (the column) keeps the record its invoice reads
 * (appointment-invoice-pricing.ts). The write also checks the total did not
 * change since it was read.
 */
export async function recordAppointmentPayment(
  db: { appointment: { updateMany: (args: any) => Promise<{ count: number }> } },
  apt: PayableAppointment,
  coveredCents: number,
  method: string | null,
  discount?: { cents: number; record: Record<string, unknown>; chargeTotalCents?: number },
): Promise<{ amountPaid: number; paymentStatus: PaymentStatus }> {
  const listTotal = appointmentTotalCents(apt);
  const discounted = !!discount && discount.cents > 0;
  // `discount.cents` is in catalogue terms (what totalAmount goes down by);
  // `discount.chargeTotalCents` the money total after it (appointment-charge.ts).
  const total = discounted ? Math.max(0, listTotal - discount.cents) : listTotal;
  // amountPaid is money: paid once it covers the money total.
  const moneyTotal = discounted ? Math.max(0, discount.chargeTotalCents ?? total) : appointmentChargeCents(apt);
  const before = Math.round(Number(apt.amountPaid ?? 0));
  const amountPaid = Math.min(moneyTotal, before + Math.max(0, coveredCents));
  const paymentStatus = amountPaid >= moneyTotal ? PaymentStatus.paid : (apt.paymentStatus as PaymentStatus);
  const { count } = await db.appointment.updateMany({
    where: {
      id: apt.id,
      amountPaid: apt.amountPaid,
      ...(discounted ? { totalAmount: apt.totalAmount } : {}),
      paymentStatus: { not: PaymentStatus.paid },
      status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
    },
    data: {
      amountPaid,
      paymentStatus,
      ...(method ? { paymentMethod: method } : {}),
      ...(discounted ? { totalAmount: total, price: total / 100, discount: discount.record } : {}),
    },
  });
  if (count !== 1) {
    throw new ConflictException({
      code: "APPOINTMENT_PAYMENT_CHANGED",
      message: "La cita acaba de cobrarse o de cambiar. Recarga y vuelve a intentarlo.",
      appointmentId: apt.id,
    });
  }
  return { amountPaid, paymentStatus };
}
