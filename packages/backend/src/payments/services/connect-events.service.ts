import { Injectable, Logger, Optional } from '@nestjs/common';
import type Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlatformStripeConfigService } from '../../platform/platform-stripe-config.service';
import { connectFieldsFromAccount } from './stripe-connect';
import { PaymentsService } from '../payments.service';
import { onlineBookingAccountOf } from '../online-booking-account';
import { OnlinePaymentAlertsService, eurosText } from './online-payment-alerts.service';

/** Whoever handles the payment events of the salons' connected accounts (set by the appointments module). */
export type ConnectPaymentHandler = (event: Stripe.Event) => Promise<void>;

export type ConnectEventResult = { received: true; duplicate?: true; ignored?: 'other_mode' | 'unhandled' | 'unknown_account' };

/**
 * Events of the salons' connected Stripe accounts (the webhook "Cuentas
 * conectadas"; its own endpoint and signing secret). Verified by the
 * controller; here each event is applied once.
 *
 * - account.updated: the account's status changed (identity checked, bank
 *   account added, something now due): saved as Stripe reports it, so the
 *   panel shows it without the salon pressing "Comprobar".
 * - account.application.deauthorized: the salon disconnected KiraRoom from
 *   its Stripe Dashboard: the connection is cleared, and it can connect again.
 *
 * - charge.dispute.created / .closed: the client disputed an online payment
 *   with her bank: it is marked on the payment and the salon is told, with the
 *   date to answer by.
 *
 * Anything else is acknowledged and not applied, so Stripe stops
 * retrying it.
 */
@Injectable()
export class ConnectEventsService {
  private readonly logger = new Logger(ConnectEventsService.name);

  private paymentHandler: ConnectPaymentHandler | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformStripe: PlatformStripeConfigService,
    // Refunds made on a salon's Stripe Dashboard are recorded here (charge.refunded).
    @Optional() private readonly payments?: PaymentsService,
    // Tells the salon about a dispute.
    @Optional() private readonly alerts?: OnlinePaymentAlertsService,
  ) {}

  /**
   * The appointments module registers itself here for the Checkout events of
   * online bookings. Done this way round so the payments module does not
   * depend on appointments (they already reach payments through other modules).
   */
  registerPaymentHandler(handler: ConnectPaymentHandler) {
    this.paymentHandler = handler;
  }

  async handle(event: Stripe.Event): Promise<ConnectEventResult> {
    // An event of the other Stripe mode than the keys in force is not applied
    // (a test account must not change a live salon's status, nor the reverse).
    const mode = this.platformStripe.mode();
    if (mode !== 'none' && typeof event.livemode === 'boolean' && event.livemode !== (mode === 'live')) {
      this.logger.warn(`Ignoring Connect event ${event.id} (${event.type}): other Stripe mode than the keys in force`);
      return { received: true, ignored: 'other_mode' };
    }

    // Each event once: Stripe delivers at least once and retries for days.
    try {
      await this.prisma.stripeWebhookEvent.create({ data: { id: event.id, type: String(event.type ?? '') } });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') return { received: true, duplicate: true };
      throw err;
    }

    try {
      return await this.route(event);
    } catch (err) {
      // Release the claim so Stripe's retry gets another go.
      await this.prisma.stripeWebhookEvent.delete({ where: { id: event.id } }).catch(() => undefined);
      throw err;
    }
  }

  private async route(event: Stripe.Event): Promise<ConnectEventResult> {
    switch (event.type) {
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        const tenant = await this.prisma.tenant.findFirst({
          where: { stripeConnectAccountId: account.id },
          select: { id: true },
        });
        if (!tenant) {
          this.logger.warn(`account.updated for ${account.id}, which no salon has connected; ignored`);
          return { received: true, ignored: 'unknown_account' };
        }
        await this.prisma.tenant.update({
          where: { id: tenant.id },
          data: connectFieldsFromAccount(account, event.livemode),
        });
        return { received: true };
      }
      case 'account.application.deauthorized': {
        const accountId = event.account;
        if (!accountId) return { received: true, ignored: 'unknown_account' };
        const tenant = await this.prisma.tenant.findFirst({
          where: { stripeConnectAccountId: accountId },
          select: { id: true },
        });
        if (!tenant) return { received: true, ignored: 'unknown_account' };
        await this.prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            stripeConnectAccountId: null,
            stripeConnectLivemode: null,
            stripeConnectChargesEnabled: false,
            stripeConnectPayoutsEnabled: false,
            stripeConnectDetailsSubmitted: false,
            stripeConnectRequirementsDue: [],
            stripeConnectDisabledReason: null,
            stripeConnectCheckedAt: new Date(),
          },
        });
        this.logger.log(`Salon ${tenant.id} disconnected its Stripe account from KiraRoom`);
        return { received: true };
      }
      case 'charge.refunded': {
        if (!this.payments) return { received: true, ignored: 'unhandled' };
        await this.payments.reconcileOnlineRefunds(event.data.object as Stripe.Charge, event.account);
        return { received: true };
      }
      case 'charge.dispute.created':
      case 'charge.dispute.closed': {
        const handled = await this.recordDispute(event.data.object as Stripe.Dispute, event.account, event.type);
        return handled ? { received: true } : { received: true, ignored: 'unhandled' };
      }
      case 'checkout.session.completed':
      case 'checkout.session.expired': {
        if (!this.paymentHandler) return { received: true, ignored: 'unhandled' };
        await this.paymentHandler(event);
        return { received: true };
      }
      default:
        return { received: true, ignored: 'unhandled' };
    }
  }

  /**
   * A dispute (chargeback) on an online booking's payment: kept on the payment
   * (metadata.dispute) and told to the salon. Only payments of online bookings,
   * on the account that took them. False when it is none of those.
   */
  private async recordDispute(
    dispute: Stripe.Dispute,
    accountId: string | null | undefined,
    type: string,
  ): Promise<boolean> {
    const paymentIntent = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : (dispute.payment_intent?.id ?? null);
    if (!paymentIntent || !accountId) return false;
    const payment = await this.prisma.payment.findFirst({
      where: { stripePaymentId: paymentIntent },
      select: { id: true, tenantId: true, metadata: true, appointmentId: true },
    });
    if (!payment || onlineBookingAccountOf(payment) !== accountId) return false;

    const dueBy = dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null;
    const record = {
      id: dispute.id,
      status: dispute.status,
      reason: dispute.reason,
      amountCents: dispute.amount,
      dueBy: dueBy ? dueBy.toISOString() : null,
    };
    const meta = (payment.metadata && typeof payment.metadata === 'object' ? payment.metadata : {}) as Record<string, unknown>;
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { metadata: { ...meta, dispute: record } as Prisma.InputJsonValue },
    });

    const amount = eurosText(dispute.amount);
    const closed = type === 'charge.dispute.closed';
    const when = dueBy ? dueBy.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
    const notice = closed
      ? dispute.status === 'won'
        ? { title: 'Disputa ganada', message: `La disputa de ${amount} de un pago online se ha resuelto a tu favor: el banco te devuelve el dinero.` }
        : { title: 'Disputa perdida', message: `La disputa de ${amount} de un pago online se ha resuelto en tu contra: el banco ha devuelto el dinero a la clienta y Stripe te lo descuenta.` }
      : {
          title: 'Una clienta ha disputado un pago online',
          message:
            `Una clienta ha reclamado a su banco un pago online de ${amount}. Stripe retiene ese importe mientras se resuelve.` +
            (when ? ` Tienes hasta el ${when} para responder con pruebas desde tu panel de Stripe.` : ' Responde con pruebas desde tu panel de Stripe.'),
        };
    await this.alerts?.tellManagers(payment.tenantId, {
      ...notice,
      link: '/dashboard/payments',
      key: `dispute-${dispute.id}-${closed ? 'closed' : 'created'}`,
    });
    return true;
  }
}
