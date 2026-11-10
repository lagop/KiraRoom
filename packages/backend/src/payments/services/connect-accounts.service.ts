import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { appBaseUrl } from '../../common/app-base-url';
import { PlatformStripeConfigService, redactStripe } from '../../platform/platform-stripe-config.service';
import { livemodeOf } from '../../platform/stripe-settings';
import {
  ConnectStatus,
  connectAccountParams,
  connectFieldsFromAccount,
  connectReturnUrls,
  connectStatusOf,
} from './stripe-connect';

const SELECT = {
  id: true,
  name: true,
  legalName: true,
  email: true,
  website: true,
  country: true,
  stripeConnectAccountId: true,
  stripeConnectLivemode: true,
  stripeConnectChargesEnabled: true,
  stripeConnectPayoutsEnabled: true,
  stripeConnectDetailsSubmitted: true,
  stripeConnectRequirementsDue: true,
  stripeConnectDisabledReason: true,
  stripeConnectCheckedAt: true,
  depositExemptReturning: true,
  minCancelHours: true,
} as const;

/** The salon's own rules for online payments, shown beside the status. */
export interface ConnectSettings {
  /** A client with a completed visit is not asked for the señal. */
  depositExemptReturning: boolean;
  /** Hours before the appointment up to which a cancellation gets the señal back. */
  minCancelHours: number;
}

/**
 * The salon's own Stripe account for online payments, connected through
 * KiraRoom's platform (see stripe-connect.ts). The salon starts the
 * connection from its panel: KiraRoom creates the account prefilled with the
 * salon's data and sends it to Stripe's own form for identity and bank
 * details. KiraRoom stores no key of the salon: payments are made with the
 * platform's key on the salon's account (direct charges).
 *
 * An account belongs to the Stripe mode (test or live) of the platform keys
 * when it was created; after a switch of mode the salon connects again
 * (the old account is simply ignored, as customers and subscriptions are).
 */
@Injectable()
export class ConnectAccountsService {
  private readonly logger = new Logger(ConnectAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformStripe: PlatformStripeConfigService,
    private readonly config: ConfigService,
  ) {}

  private platformLivemode(): boolean | null {
    return livemodeOf(this.platformStripe.mode());
  }

  /** What the panel shows, from what is stored (no call to Stripe). */
  async status(tenantId: string): Promise<ConnectStatus & { platformReady: boolean; settings: ConnectSettings }> {
    const row = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: SELECT });
    if (!row) throw new BadRequestException('Salón no encontrado.');
    return {
      ...connectStatusOf(row, this.platformLivemode()),
      platformReady: !!this.platformStripe.client(),
      settings: {
        depositExemptReturning: row.depositExemptReturning,
        minCancelHours: row.minCancelHours,
      },
    };
  }

  /** The salon's rules for online payments. Only what is sent changes. */
  async updateSettings(tenantId: string, input: { depositExemptReturning?: boolean }) {
    if (typeof input.depositExemptReturning === 'boolean') {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { depositExemptReturning: input.depositExemptReturning },
      });
    }
    return this.status(tenantId);
  }

  /** Asks Stripe for the account's current state, saves it and returns it. */
  async refresh(tenantId: string): Promise<ConnectStatus & { platformReady: boolean; settings: ConnectSettings }> {
    const row = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: SELECT });
    if (!row) throw new BadRequestException('Salón no encontrado.');
    const stripe = this.requireStripe();
    const livemode = this.platformLivemode();
    const current = connectStatusOf(row, livemode);
    // Nothing to refresh without an account of the mode in force.
    if (!row.stripeConnectAccountId || current.otherMode) return this.status(tenantId);
    try {
      const account = await stripe.accounts.retrieve(row.stripeConnectAccountId);
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: connectFieldsFromAccount(account, livemode),
      });
    } catch (err) {
      this.logger.warn(`Cannot read the Stripe account of tenant ${tenantId}: ${redactStripe((err as Error).message)}`);
      throw new ServiceUnavailableException('No se ha podido consultar el estado en Stripe. Inténtalo de nuevo en un momento.');
    }
    return this.status(tenantId);
  }

  /**
   * Creates the salon's account if it has none of the mode in force, and
   * returns a one-use link to Stripe's form (identity, bank details), which
   * brings the salon back to the panel. Also used to finish what Stripe
   * still asks for.
   */
  async startOnboarding(tenantId: string): Promise<{ url: string }> {
    const row = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: SELECT });
    if (!row) throw new BadRequestException('Salón no encontrado.');
    const stripe = this.requireStripe();
    const livemode = this.platformLivemode();
    const current = connectStatusOf(row, livemode);

    let accountId = current.otherMode ? null : row.stripeConnectAccountId;
    try {
      if (!accountId) {
        const account = await stripe.accounts.create(
          connectAccountParams({
            tenantId: row.id,
            name: row.name,
            legalName: row.legalName,
            email: row.email,
            website: row.website,
            country: row.country,
          }),
          // One account per salon even if the button is pressed twice.
          { idempotencyKey: `connect-account-${row.id}-${livemode ? 'live' : 'test'}` },
        );
        accountId = account.id;
        await this.prisma.tenant.update({
          where: { id: tenantId },
          data: connectFieldsFromAccount(account, livemode),
        });
      }
      const { returnUrl, refreshUrl } = connectReturnUrls(appBaseUrl((k) => this.config.get<string>(k)));
      const link = await stripe.accountLinks.create({
        account: accountId,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
      return { url: link.url };
    } catch (err) {
      const message = redactStripe((err as Error).message ?? 'error desconocido');
      this.logger.error(`Connect onboarding failed for tenant ${tenantId}: ${message}`);
      throw new ServiceUnavailableException(
        /connect/i.test(message)
          ? 'Los cobros online todavía no están disponibles en KiraRoom. Vuelve a intentarlo más tarde.'
          : 'No se ha podido abrir el alta en Stripe. Inténtalo de nuevo en un momento.',
      );
    }
  }

  private requireStripe() {
    const stripe = this.platformStripe.client();
    if (!stripe) {
      throw new ServiceUnavailableException('Los pagos de KiraRoom no están configurados todavía. Inténtalo más tarde.');
    }
    return stripe;
  }
}
