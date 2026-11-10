import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PaymentsService } from '../payments/payments.service';
import { onlineBookingAccountOf } from '../payments/online-booking-account';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
import { PrismaService } from '../common/prisma/prisma.service';
import { publicPrice, publicPriceSettings } from '../common/public-price';
import { PlatformStripeConfigService, redactStripe } from '../platform/platform-stripe-config.service';
import { livemodeOf } from '../platform/stripe-settings';
import { connectStatusOf, ConnectTenantRow } from '../payments/services/stripe-connect';
import {
  OnlinePaymentChoice,
  chooseOnlinePayment,
  onlinePaymentOffer,
} from '../payments/online-payment-policy';
import { clientEmailFilter, findClientIdByPhone, normalizeClientEmail } from '../clients/client-contact';
import { deleteAppointmentRow } from './appointment-delete';
import { appointmentCancelUrl } from './public-cancel-link';

/** Stripe keeps a Checkout Session open for at least 30 minutes. */
export const CHECKOUT_MINUTES = 31;
/** The slot stays held a few minutes longer than the Checkout, so a payment made at the last minute still finds its booking. */
export const HOLD_MINUTES = 36;

/** What a booking has to pay online, decided before it is created. */
export interface OnlinePaymentPlan extends OnlinePaymentChoice {
  totalCents: number;
  currency: string;
  serviceName: string;
  /** The salon's connected Stripe account the payment is made on. */
  accountId: string;
  livemode: boolean | null;
}

/** What the booking's answer carries when the client has to pay to confirm it. */
export interface OnlinePaymentRequired {
  required: true;
  kind: 'deposit' | 'full';
  amountCents: number;
  currency: string;
  /** Stripe's payment page. */
  checkoutUrl: string;
  /** Until when the slot is held for her. */
  holdUntil: string;
}

export type PaymentOutcome =
  | { result: 'paid'; appointmentId: string; tenantId: string }
  | { result: 'already_paid'; appointmentId: string }
  | { result: 'refunded_no_booking' }
  | { result: 'ignored' };

const BOOKING_KIND = 'online_booking';

/**
 * Online payment when a client books (señal / pago anticipado), on the
 * salon's own connected Stripe account (direct charges: the money goes to
 * the salon; KiraRoom keeps nothing and takes no commission).
 *
 *   plan      decides, before the booking exists, whether this client must
 *             pay and how much (the salon's rules, her history, her choice);
 *   checkout  the payment page on the salon's account;
 *   complete  Stripe says it was paid: the held booking becomes real;
 *   sweep     a hold nobody paid is released (the slot is free again).
 *
 * The amounts are computed here from the catalogue, never from what the
 * browser sends, on the same tax-included price the public page shows.
 */
@Injectable()
export class OnlineBookingPaymentService {
  private readonly logger = new Logger(OnlineBookingPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly platformStripe?: PlatformStripeConfigService,
    @Optional() private readonly config?: ConfigService,
    // PaymentsService is looked up when a refund is needed, not injected: it reaches
    // the appointments through its own imports, and injecting it would close a cycle.
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** A client with a completed visit, recognised by her email AND phone together. */
  private async isReturningClient(
    tenantId: string,
    info: { email?: string | null; phone?: string | null } | undefined,
  ): Promise<boolean> {
    const email = normalizeClientEmail(info?.email) ?? undefined;
    const phone = info?.phone?.trim();
    if (!email || !phone) return false;
    const byEmail = await this.prisma.client.findFirst({
      where: { tenantId, email: clientEmailFilter(email) },
      select: { id: true },
    });
    if (!byEmail) return false;
    const byPhone = await findClientIdByPhone(this.prisma, tenantId, phone);
    if (byPhone !== byEmail.id) return false;
    const visits = await this.prisma.appointment.count({
      where: { tenantId, clientId: byEmail.id, status: 'completed', isTest: false },
    });
    return visits > 0;
  }

  /**
   * What this booking has to pay online, or null when it books freely:
   * the salon cannot take payments, the service asks for nothing, she is
   * exempt from the señal, or she did not choose to prepay.
   */
  async plan(
    tenantId: string,
    dto: {
      serviceId: string;
      payment?: 'deposit' | 'full' | null;
      clientInfo?: { email?: string | null; phone?: string | null };
    },
  ): Promise<OnlinePaymentPlan | null> {
    const platform = this.platformStripe;
    if (!platform || !platform.client()) return null;

    const [service, tenant] = await Promise.all([
      this.prisma.service.findFirst({
        where: { id: dto.serviceId, tenantId },
        select: {
          name: true,
          price: true,
          currency: true,
          depositRequired: true,
          depositAmount: true,
          depositPercentage: true,
          allowPrepay: true,
        },
      }),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          fiscalSettings: true,
          depositExemptReturning: true,
          stripeConnectAccountId: true,
          stripeConnectLivemode: true,
          stripeConnectChargesEnabled: true,
          stripeConnectPayoutsEnabled: true,
          stripeConnectDetailsSubmitted: true,
          stripeConnectRequirementsDue: true,
          stripeConnectDisabledReason: true,
          stripeConnectCheckedAt: true,
        },
      }),
    ]);
    if (!service || !tenant || !tenant.stripeConnectAccountId) return null;

    const livemode = livemodeOf(platform.mode());
    const status = connectStatusOf(tenant as unknown as ConnectTenantRow, livemode);
    if (!status.canCharge) return null;

    const priceEuros = publicPrice(service.price, publicPriceSettings(tenant.fiscalSettings));
    const exempt = tenant.depositExemptReturning === true && (await this.isReturningClient(tenantId, dto.clientInfo));
    const offer = onlinePaymentOffer(
      {
        priceEuros,
        depositRequired: service.depositRequired,
        depositAmount: service.depositAmount?.toString() ?? null,
        depositPercentage: service.depositPercentage?.toString() ?? null,
        allowPrepay: service.allowPrepay,
      },
      { canCharge: true, exempt },
    );
    const choice = chooseOnlinePayment(offer, dto.payment ?? null);
    if (!choice) return null;
    return {
      ...choice,
      totalCents: offer.totalCents,
      currency: (service.currency || 'EUR').toLowerCase(),
      serviceName: service.name,
      accountId: tenant.stripeConnectAccountId,
      livemode,
    };
  }

  /** The payment page on the salon's account. The booking id and salon travel in its metadata. */
  async createCheckout(
    appointment: { id: string; tenantId: string; client?: { email?: string | null } | null },
    plan: OnlinePaymentPlan,
    now: Date = new Date(),
  ): Promise<{ checkoutUrl: string; sessionId: string; holdUntil: Date }> {
    const stripe = this.platformStripe?.client();
    if (!stripe) throw new ServiceUnavailableException('Los pagos online no están disponibles ahora mismo.');
    const link = appointmentCancelUrl(appointment.id);
    if (!link) throw new ServiceUnavailableException('Los pagos online no están disponibles ahora mismo.');

    const metadata = {
      kind: BOOKING_KIND,
      appointmentId: appointment.id,
      tenantId: appointment.tenantId,
      payKind: plan.kind,
    };
    const email = appointment.client?.email?.trim();
    try {
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: plan.currency,
                unit_amount: plan.cents,
                product_data: {
                  name: plan.kind === 'deposit' ? `Señal · ${plan.serviceName}` : `Pago anticipado · ${plan.serviceName}`,
                },
              },
            },
          ],
          ...(email ? { customer_email: email } : {}),
          client_reference_id: appointment.id,
          metadata,
          payment_intent_data: { metadata, description: `${plan.serviceName} (reserva online)` },
          success_url: `${link}?pago=ok`,
          cancel_url: `${link}?pago=cancelado`,
          expires_at: Math.floor(now.getTime() / 1000) + CHECKOUT_MINUTES * 60,
        },
        {
          stripeAccount: plan.accountId,
          idempotencyKey: `booking-checkout-${appointment.id}`,
        },
      );
      if (!session.url) throw new Error('Stripe returned no checkout url');
      return {
        checkoutUrl: session.url,
        sessionId: session.id,
        holdUntil: new Date(now.getTime() + HOLD_MINUTES * 60_000),
      };
    } catch (err) {
      this.logger.error(`Checkout for booking ${appointment.id} failed: ${redactStripe((err as Error).message ?? '')}`);
      throw new ServiceUnavailableException('No se ha podido iniciar el pago. Inténtalo de nuevo en un momento.');
    }
  }

  /**
   * Stripe says a booking's Checkout was paid: the held booking becomes
   * real (confirmed, or pending the salon's approval, as it would have been)
   * and the payment is recorded. Applied once: a second delivery changes
   * nothing. If the hold is gone (a payment at the very last minute) the
   * client is refunded in full instead of being charged for nothing.
   */
  async complete(session: Stripe.Checkout.Session, eventAccount: string | null | undefined): Promise<PaymentOutcome> {
    const meta = session.metadata ?? {};
    if (meta.kind !== BOOKING_KIND || !meta.appointmentId || !meta.tenantId) return { result: 'ignored' };
    if (session.payment_status !== 'paid') return { result: 'ignored' };

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: meta.tenantId },
      select: { stripeConnectAccountId: true },
    });
    // Only the salon's own account can pay its bookings.
    if (!tenant?.stripeConnectAccountId || (eventAccount && eventAccount !== tenant.stripeConnectAccountId)) {
      this.logger.warn(`Checkout ${session.id} for tenant ${meta.tenantId} came from another account; ignored`);
      return { result: 'ignored' };
    }

    const appointment = await this.prisma.appointment.findFirst({
      where: { id: meta.appointmentId, tenantId: meta.tenantId },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        status: true,
        statusAfterPayment: true,
        paymentHoldUntil: true,
        checkoutSessionId: true,
        onlinePaymentKind: true,
        totalAmount: true,
        amountPaid: true,
        depositPaid: true,
        currency: true,
        service: { select: { name: true } },
      },
    });

    if (!appointment) {
      await this.refundUnclaimed(session, tenant.stripeConnectAccountId);
      return { result: 'refunded_no_booking' };
    }
    if (appointment.checkoutSessionId !== session.id) {
      this.logger.warn(`Checkout ${session.id} is not the one held for booking ${appointment.id}; ignored`);
      return { result: 'ignored' };
    }
    if (!appointment.paymentHoldUntil) return { result: 'already_paid', appointmentId: appointment.id };

    const paidCents = session.amount_total ?? 0;
    const kind = appointment.onlinePaymentKind === 'full' ? 'full' : 'deposit';
    const total = Math.round(Number(appointment.totalAmount ?? 0));
    const paymentIntent =
      typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null);

    await this.prisma.$transaction(async (tx) => {
      // Written over the hold it read: a second delivery finds it released.
      const claimed = await tx.appointment.updateMany({
        where: { id: appointment.id, tenantId: appointment.tenantId, paymentHoldUntil: { not: null } },
        data: {
          paymentHoldUntil: null,
          status: appointment.statusAfterPayment ?? 'confirmed',
          statusAfterPayment: null,
          amountPaid: Math.round(Number(appointment.amountPaid ?? 0)) + paidCents,
          ...(kind === 'deposit'
            ? { depositPaid: true, depositPaymentIntentId: paymentIntent }
            : { paymentStatus: 'paid' as const }),
        },
      });
      if (claimed.count === 0) return;
      await tx.payment.create({
        data: {
          tenantId: appointment.tenantId,
          clientId: appointment.clientId,
          appointmentId: appointment.id,
          stripePaymentId: paymentIntent,
          amount: paidCents,
          currency: (appointment.currency || 'EUR').toUpperCase(),
          type: kind === 'deposit' ? 'deposit' : 'appointment',
          status: 'paid',
          method: 'card',
          isDeposit: kind === 'deposit',
          ...(kind === 'deposit' ? { depositAmount: paidCents, remainingAmount: Math.max(0, total - paidCents) } : {}),
          description: kind === 'deposit' ? `Señal · ${appointment.service?.name ?? ''}`.trim() : `Pago anticipado · ${appointment.service?.name ?? ''}`.trim(),
          metadata: { online: true, checkoutSessionId: session.id, stripeAccount: tenant.stripeConnectAccountId },
        },
      });
    });
    return { result: 'paid', appointmentId: appointment.id, tenantId: appointment.tenantId };
  }

  /**
   * A booking that was paid online is cancelled: what she paid goes back on
   * the salon's Stripe account, in full (a cancellation in time by her, one by
   * the salon, a booking the salon never confirmed). Refused to nothing: if
   * Stripe cannot do it now, the booking stays cancelled, the failure is
   * logged loudly and the salon can give it back from Pagos. Returns what was
   * given back, and how many payments could not be.
   */
  async refundForCancellation(
    appointment: { id: string; tenantId: string },
    reason: string,
    actorId?: string | null,
  ): Promise<{ refundedCents: number; failed: number } | null> {
    const payments = this.moduleRef?.get(PaymentsService, { strict: false });
    if (!payments) return null;
    const rows = await this.prisma.payment.findMany({
      where: { tenantId: appointment.tenantId, appointmentId: appointment.id, status: 'paid', stripePaymentId: { not: null } },
      select: { id: true, amount: true, metadata: true, refunds: { where: { status: 'succeeded' }, select: { amount: true } } },
    });
    const online = rows.filter((p) => onlineBookingAccountOf(p));
    if (online.length === 0) return null;
    let refundedCents = 0;
    let failed = 0;
    for (const p of online) {
      const left = p.amount - p.refunds.reduce((s, r) => s + r.amount, 0);
      if (left <= 0) continue;
      try {
        await payments.refundPayment(appointment.tenantId, p.id, { amount: left, reason }, actorId ?? null);
        refundedCents += left;
      } catch (err) {
        failed++;
        this.logger.error(
          `Online payment ${p.id} of cancelled booking ${appointment.id} could NOT be refunded, do it from Pagos: ${(err as Error).message}`,
        );
      }
    }
    return { refundedCents, failed };
  }

  /**
   * The payment page of a held booking, to open it again (she closed it or
   * came back from Stripe without paying). Null when it can no longer be
   * paid: it expired, or was paid.
   */
  async reopenCheckoutUrl(appointment: { tenantId: string; checkoutSessionId: string | null }): Promise<string | null> {
    const stripe = this.platformStripe?.client();
    if (!stripe || !appointment.checkoutSessionId) return null;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: appointment.tenantId },
      select: { stripeConnectAccountId: true },
    });
    if (!tenant?.stripeConnectAccountId) return null;
    try {
      const session = await stripe.checkout.sessions.retrieve(appointment.checkoutSessionId, undefined, {
        stripeAccount: tenant.stripeConnectAccountId,
      });
      return session.status === 'open' && session.url ? session.url : null;
    } catch (err) {
      this.logger.warn(`Checkout of booking could not be read: ${redactStripe((err as Error).message ?? '')}`);
      return null;
    }
  }

  /**
   * She changed her mind before paying: the page is closed so it cannot be
   * paid later, and the held booking goes. Nothing is announced to anyone:
   * the booking was never announced. False when it was already paid.
   */
  async releaseByClient(appointment: { id: string; tenantId: string; checkoutSessionId: string | null }): Promise<boolean> {
    const stripe = this.platformStripe?.client();
    if (stripe && appointment.checkoutSessionId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: appointment.tenantId },
        select: { stripeConnectAccountId: true },
      });
      if (tenant?.stripeConnectAccountId) {
        try {
          const session = await stripe.checkout.sessions.retrieve(appointment.checkoutSessionId, undefined, {
            stripeAccount: tenant.stripeConnectAccountId,
          });
          // Paid while she was deciding: it stands (the payment notice confirms it).
          if (session.payment_status === 'paid') return false;
          if (session.status === 'open') {
            await stripe.checkout.sessions.expire(appointment.checkoutSessionId, undefined, {
              stripeAccount: tenant.stripeConnectAccountId,
            });
          }
        } catch (err) {
          this.logger.warn(`Checkout of booking ${appointment.id} not closed: ${redactStripe((err as Error).message ?? '')}`);
        }
      }
    }
    return this.releaseHold(appointment.id, appointment.tenantId);
  }

  /** A Checkout nobody paid: its held booking is released, the slot is free. */
  async expire(session: Stripe.Checkout.Session): Promise<boolean> {
    const meta = session.metadata ?? {};
    if (meta.kind !== BOOKING_KIND || !meta.appointmentId || !meta.tenantId) return false;
    return this.releaseHold(meta.appointmentId, meta.tenantId, session.id);
  }

  /** Deletes a booking that is still held and unpaid. Anything with money on it stays. */
  private async releaseHold(appointmentId: string, tenantId: string, sessionId?: string): Promise<boolean> {
    const held = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, tenantId, paymentHoldUntil: { not: null }, depositPaid: false },
      select: { id: true, checkoutSessionId: true },
    });
    if (!held || (sessionId && held.checkoutSessionId && held.checkoutSessionId !== sessionId)) return false;
    const payments = await this.prisma.payment.count({ where: { tenantId, appointmentId } });
    if (payments > 0) return false;
    await deleteAppointmentRow(this.prisma, appointmentId);
    return true;
  }

  /**
   * Holds that ran out: for each, ask Stripe first. Paid after all (the
   * notice has not arrived): complete it. Still open: close the page so it
   * cannot be paid later, then release. Returns what was done.
   */
  async sweep(now: Date = new Date()): Promise<{ released: number; completed: number }> {
    const stale = await this.prisma.appointment.findMany({
      where: { paymentHoldUntil: { lt: now }, depositPaid: false, checkoutSessionId: { not: null } },
      take: 100,
      select: { id: true, tenantId: true, checkoutSessionId: true },
    });
    let released = 0;
    let completed = 0;
    const stripe = this.platformStripe?.client() ?? null;
    for (const row of stale) {
      try {
        const tenant = await this.prisma.tenant.findUnique({
          where: { id: row.tenantId },
          select: { stripeConnectAccountId: true },
        });
        const account = tenant?.stripeConnectAccountId;
        if (stripe && account && row.checkoutSessionId) {
          const session = await stripe.checkout.sessions.retrieve(row.checkoutSessionId, undefined, { stripeAccount: account });
          if (session.payment_status === 'paid') {
            const out = await this.complete(session, account);
            if (out.result === 'paid') completed++;
            continue;
          }
          if (session.status === 'open') {
            await stripe.checkout.sessions.expire(row.checkoutSessionId, undefined, { stripeAccount: account });
          }
        }
        if (await this.releaseHold(row.id, row.tenantId)) released++;
      } catch (err) {
        this.logger.warn(`Hold of booking ${row.id} not swept: ${redactStripe((err as Error).message ?? '')}`);
      }
    }
    return { released, completed };
  }

  /** A payment arrived for a booking that no longer exists: give it back. */
  private async refundUnclaimed(session: Stripe.Checkout.Session, accountId: string): Promise<void> {
    const paymentIntent =
      typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null);
    this.logger.error(
      `Payment ${paymentIntent ?? session.id} arrived for booking ${session.metadata?.appointmentId}, which no longer exists: refunding it`,
    );
    const stripe = this.platformStripe?.client();
    if (!stripe || !paymentIntent) return;
    try {
      await stripe.refunds.create({ payment_intent: paymentIntent }, { stripeAccount: accountId, idempotencyKey: `refund-${session.id}` });
    } catch (err) {
      this.logger.error(`Refund of ${paymentIntent} failed, do it by hand: ${redactStripe((err as Error).message ?? '')}`);
    }
  }
}
