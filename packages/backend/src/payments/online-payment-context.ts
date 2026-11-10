/**
 * What every page that lists a salon's services to the public needs to say
 * what a client may pay online: whether the salon can take payments now, and
 * the service's offer in place of its raw deposit settings. Shared by the
 * services list, the salon's public page and the widget, so they never
 * disagree (the booking itself recomputes everything, OnlineBookingPaymentService).
 */
import type { PrismaService } from '../common/prisma/prisma.service';
import type { StripeMode } from '../platform/stripe-settings';
import { livemodeOf } from '../platform/stripe-settings';
import { connectStatusOf, ConnectTenantRow } from './services/stripe-connect';
import { OnlinePaymentContext, onlinePaymentOffer } from './online-payment-policy';

/** The service columns the offer is made from. Selected, then replaced by `onlinePayment`. */
export const DEPOSIT_SERVICE_SELECT = {
  depositRequired: true,
  depositAmount: true,
  depositPercentage: true,
  allowPrepay: true,
} as const;

/** The platform's Stripe keys, as far as this needs them. */
export interface PlatformStripeLike {
  client(): unknown;
  mode(): StripeMode;
}

/**
 * Whether this salon can take online payments now: its connected Stripe
 * account can charge, in the Stripe mode of the platform's keys in force.
 * Without keys, or with an account of the other mode, it cannot.
 */
export async function onlinePaymentContextFor(
  prisma: Pick<PrismaService, 'tenant'>,
  platform: PlatformStripeLike | null | undefined,
  tenantId: string,
): Promise<OnlinePaymentContext> {
  if (!platform || !platform.client()) return { canCharge: false };
  const row = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      stripeConnectAccountId: true,
      stripeConnectLivemode: true,
      stripeConnectChargesEnabled: true,
      stripeConnectPayoutsEnabled: true,
      stripeConnectDetailsSubmitted: true,
      stripeConnectRequirementsDue: true,
      stripeConnectDisabledReason: true,
      stripeConnectCheckedAt: true,
    },
  });
  if (!row) return { canCharge: false };
  return { canCharge: connectStatusOf(row as ConnectTenantRow, livemodeOf(platform.mode())).canCharge };
}

/**
 * The public shape of a service: its raw deposit settings replaced by what
 * a client may pay now (`onlinePayment`, cents). `price` is the euros the
 * client sees, tax included. The señal exemption of a returning client is
 * decided at booking, once she is known, not here.
 */
export function withOnlinePayment<
  T extends {
    price: number;
    depositRequired: boolean | null;
    depositAmount: unknown;
    depositPercentage: unknown;
    allowPrepay: boolean | null;
  },
>(service: T, ctx: OnlinePaymentContext) {
  const { depositRequired, depositAmount, depositPercentage, allowPrepay, ...rest } = service;
  return {
    ...rest,
    onlinePayment: onlinePaymentOffer(
      {
        priceEuros: service.price,
        depositRequired,
        depositAmount: depositAmount === null || depositAmount === undefined ? null : String(depositAmount),
        depositPercentage: depositPercentage === null || depositPercentage === undefined ? null : String(depositPercentage),
        allowPrepay,
      },
      ctx,
    ),
  };
}
