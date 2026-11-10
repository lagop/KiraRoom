import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlatformStripeConfigService } from '../../platform/platform-stripe-config.service';
import { connectFieldsFromAccount } from './stripe-connect';

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
 * Payment events (checkout, refunds, disputes) are added with the payment
 * itself. Anything else is acknowledged and not applied, so Stripe stops
 * retrying it.
 */
@Injectable()
export class ConnectEventsService {
  private readonly logger = new Logger(ConnectEventsService.name);

  private paymentHandler: ConnectPaymentHandler | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformStripe: PlatformStripeConfigService,
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
}
