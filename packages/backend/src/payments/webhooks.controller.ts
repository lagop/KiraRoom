import { ParseUUIDPipe, Controller, Post, Body, Headers, RawBodyRequest, Req, HttpCode, HttpStatus, Logger } from "@nestjs/common";
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { EmailService } from '../notifications/services/email.service';
import { AddOnsService } from './services/addons.service';
import { MessageBundlesService } from '../message-bundles/message-bundles.service';

@Controller('webhooks')
export class WebhooksController {
  private stripe: Stripe;
  private webhookSecret: string;
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly addonsService: AddOnsService,
    private readonly messageBundles: MessageBundlesService,
  ) {
    const apiKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (apiKey && apiKey.startsWith('sk_')) {
      this.stripe = new Stripe(apiKey, {
        apiVersion: '2024-12-18.acacia' as any,
      });
    }
    this.webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET', '');
  }

  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  async handleStripeWebhook(
    @Headers('stripe-signature') signature: string,
    @Body() body: any,
    @Req() req: RawBodyRequest<Request>,
  ) {
    // If no webhook secret configured, just process the event directly
    if (!this.webhookSecret || !this.stripe) {
      console.warn('[WebhooksController] Stripe webhook secret not configured - processing event directly');
      return this.processStripeEvent(body);
    }

    // Verify webhook signature
    const rawBody = req.rawBody?.toString() || JSON.stringify(body);
    
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (err) {
      console.error('[WebhooksController] Webhook signature verification failed:', err);
      return { received: true, status: 'signature_verification_failed' };
    }

    // Process the event
    return this.processStripeEvent(event);
  }

  private async processStripeEvent(event: Stripe.Event) {
    console.log(`[WebhooksController] Processing Stripe event: ${event.type}`);

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await this.handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;

      case 'charge.refunded':
        await this.handleChargeRefunded(event.data.object as Stripe.Charge);
        break;

      case 'customer.subscription.created':
        await this.handleSubscriptionLifecycle(
          event.data.object as Stripe.Subscription,
          'created',
        );
        break;

      case 'customer.subscription.updated':
        await this.handleSubscriptionLifecycle(
          event.data.object as Stripe.Subscription,
          'updated',
        );
        break;

      case 'customer.subscription.deleted':
        await this.handleSubscriptionLifecycle(
          event.data.object as Stripe.Subscription,
          'deleted',
        );
        break;

      case 'invoice.paid':
        await this.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await this.handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      default:
        console.log(`[WebhooksController] Unhandled event type: ${event.type}`);
    }

    return { received: true };
  }

  private async handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
    console.log(`[WebhooksController] PaymentIntent succeeded: ${paymentIntent.id}`);
    
    const tenantId = paymentIntent.metadata?.tenantId;
    const appointmentId = paymentIntent.metadata?.appointmentId;

    if (tenantId && appointmentId) {
      // Find payment by Stripe ID and update status
      try {
        // First find the payment by stripePaymentId
        const payment = await this.paymentsService.getPaymentByStripeId(paymentIntent.id, tenantId);
        if (payment) {
          await this.paymentsService.updatePaymentStatus(
            tenantId,
            payment.id,
            'paid',
          );
        }
      } catch (e) {
        console.log('[WebhooksController] Payment update error (may not exist yet):', e.message);
      }
    }
  }

  private async handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
    console.log(`[WebhooksController] PaymentIntent failed: ${paymentIntent.id}`);
    
    const tenantId = paymentIntent.metadata?.tenantId;
    
    if (tenantId) {
      try {
        // First find the payment by stripePaymentId
        const payment = await this.paymentsService.getPaymentByStripeId(paymentIntent.id, tenantId);
        if (payment) {
          await this.paymentsService.updatePaymentStatus(
            tenantId,
            payment.id,
            'failed',
          );
        }
      } catch (e) {
        console.log('[WebhooksController] Payment update error (may not exist yet):', e.message);
      }
    }
  }

  private async handleChargeRefunded(charge: Stripe.Charge) {
    console.log(`[WebhooksController] Charge refunded: ${charge.id}`);
    
    const paymentIntentId = charge.payment_intent as string;
    if (paymentIntentId) {
      console.log(`[WebhooksController] Processing refund for payment: ${paymentIntentId}`);
    }
  }

  /**
   * Router for `customer.subscription.{created,updated,deleted}`. The
   * `metadata.kind` field on each subscription decides the destination:
   *
   *   - `metadata.kind === 'addon'`      -> P2A-receptionist-v2: provision
   *                                       or cancel the tenant_add_on row.
   *   - anything else (incl. undefined)  -> legacy plan subscription
   *                                       status reconciliation.
   *
   * This split lets us reuse the same Stripe event for both the plan
   * and add-ons without two Stripe products.
   */
  private async handleSubscriptionLifecycle(
    subscription: Stripe.Subscription,
    event: 'created' | 'updated' | 'deleted',
  ) {
    const kind = subscription.metadata?.kind;
    if (kind === 'addon') {
      await this.handleAddonSubscription(subscription, event);
      return;
    }
    await this.handlePlanSubscription(subscription, event);
  }

  /**
   * Add-on provisioning path. Reads `metadata.tenantId`,
   * `metadata.addOnKey` and the Stripe SubscriptionItem itself.
   * Idempotent (the service uses upsert on (tenantId, addOnId)).
   */
  private async handleAddonSubscription(
    subscription: Stripe.Subscription,
    event: 'created' | 'updated' | 'deleted',
  ) {
    const item = subscription.items?.data?.[0];
    const tenantId = subscription.metadata?.tenantId;
    const addOnKey =
      (item?.metadata?.addOnKey as string | undefined) ??
      (subscription.metadata?.addOnKey as string | undefined);
    if (!tenantId || !addOnKey) {
      this.logger.warn(
        `Addon subscription ${subscription.id} missing tenantId or addOnKey metadata`,
      );
      return;
    }

    if (event === 'deleted') {
      await this.addonsService.cancelFromStripe({
        tenantId,
        addOnKey,
        cancelledAt: new Date(),
      });
      return;
    }

    // 'created' and 'updated' share the same upsert path. Stripe reuses
    // the same SubscriptionItem id across duplicates, so we store it.
    await this.addonsService.provisionFromStripe({
      tenantId,
      addOnKey,
      stripeSubscriptionItemId: item?.id ?? subscription.id,
      status: mapStripeStatus(subscription.status),
      // current_period_end lives on the subscription, not the item.
      // Stripe sends a Unix timestamp here (seconds).
      currentPeriodEnd:
        subscription.current_period_end && subscription.current_period_end > 0
          ? new Date(subscription.current_period_end * 1000)
          : null,
    });
  }

  /**
   * Legacy path: tenant plan subscription. Kept verbatim from the
   * Sprint 2/2.2 rollout to keep grace-period / dunning logic intact.
   */
  private async handlePlanSubscription(
    subscription: Stripe.Subscription,
    event: 'created' | 'updated' | 'deleted',
  ) {
    const tenantId = subscription.metadata?.tenantId;
    if (!tenantId) {
      this.logger.log(
        `[WebhooksController] ${event} subscription ${subscription.id} has no tenantId metadata`,
      );
      return;
    }

    if (event === 'created') {
      this.logger.log(
        `[WebhooksController] Activating subscription for tenant: ${tenantId}`,
      );
      return;
    }

    this.logger.log(
      `[WebhooksController] Subscription status for tenant ${tenantId}: ${subscription.status}`,
    );

    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, subscriptionStatus: true },
      });
      if (!tenant) return;

      if (subscription.status === 'active') {
        if (
          tenant.subscriptionStatus === 'past_due' ||
          tenant.subscriptionStatus === 'suspended'
        ) {
          await this.prisma.tenant.update({
            where: { id: tenantId },
            data: {
              subscriptionStatus: 'active',
              paymentFailedAt: null,
              gracePeriodEndsAt: null,
              readOnlyUntil: null,
            },
          });
          this.logger.log(
            `Recovered tenant ${tenantId} via subscription update: ${tenant.subscriptionStatus} -> active`,
          );
        }
      } else if (subscription.status === 'canceled') {
        if (tenant.subscriptionStatus !== 'cancelled') {
          await this.prisma.tenant.update({
            where: { id: tenantId },
            data: {
              subscriptionStatus: 'cancelled',
              cancelledAt: new Date(),
              readOnlyUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          });
          this.logger.log(
            `Tenant ${tenantId} marked cancelled via Stripe subscription update`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to apply subscription update for tenant ${tenantId}: ${(err as Error).message}`,
      );
    }
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice) {
    console.log(`[WebhooksController] Invoice paid: ${invoice.id}`);

    const customerId =
      typeof invoice.customer === "string"
        ? invoice.customer
        : invoice.customer?.id;
    if (!customerId) {
      this.logger.warn(
        `Invoice ${invoice.id} has no customer id; skipping recovery.`,
      );
      return;
    }

    try {
      const tenant = await this.prisma.tenant.findFirst({
        where: { stripeCustomerId: customerId },
        select: { id: true, name: true, subscriptionStatus: true },
      });
      if (!tenant) {
        this.logger.warn(
          `No Tenant found for Stripe customer ${customerId}; skipping recovery.`,
        );
        return;
      }

      // Sprint 2 / 2.2 — a successful payment after past_due /
      // suspended clears the grace state and reactivates the tenant.
      // Skip if the tenant is in a different terminal state (cancelled,
      // trialing) so we never overwrite an intentional SaaS-admin
      // suspension or a fresh trial.
      // P2A-receptionist-v2 — handle metered `message_bundles` top-ups.
      // The Stripe invoice's line items include a per-bundle quantity;
      // we only credit the wallet for items that map to the
      // `message_bundles` add-on key. Multiplied by 100 to convert
      // cents -> credit units (1 credit = €1 of WhatsApp marketing
      // cost approximately; the SaaS-admin can configure this later
      // via the catalog).
      try {
        const lines = invoice.lines?.data ?? [];
        for (const line of lines) {
          if (line.metadata?.kind !== 'addon') continue;
          if (line.metadata?.addOnKey !== 'message_bundles') continue;
          // The metered quantity is the *units* of credit the customer
          // bought. We round to the nearest integer.
          const qty = line.quantity ?? 0;
          if (qty > 0) {
            await this.messageBundles.creditTopUp({
              tenantId: tenant.id,
              credits: Math.floor(qty),
              source: 'stripe',
              stripeInvoiceId: invoice.id,
            });
            this.logger.log(
              `message_bundles topup tenant=${tenant.id} credits=${Math.floor(qty)} invoice=${invoice.id}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(
          `Failed to credit message-bundles wallet for invoice ${invoice.id}: ${(err as Error).message}`,
        );
      }

      if (
        tenant.subscriptionStatus === "past_due" ||
        tenant.subscriptionStatus === "suspended"
      ) {
        await this.prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            subscriptionStatus: "active",
            paymentFailedAt: null,
            gracePeriodEndsAt: null,
            readOnlyUntil: null,
          },
        });
        this.logger.log(
          `Recovered tenant ${tenant.name} (${tenant.id}) from ${tenant.subscriptionStatus} → active after invoice ${invoice.id}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to clear grace state for invoice ${invoice.id}: ${(err as Error).message}`,
      );
    }
  }

  private async handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
    console.log(`[WebhooksController] Invoice payment failed: ${invoice.id}`);

    const customerId =
      typeof invoice.customer === "string"
        ? invoice.customer
        : invoice.customer?.id;
    if (!customerId) {
      this.logger.warn(
        `Invoice ${invoice.id} has no customer id; skipping payment-failed handling.`,
      );
      return;
    }

    try {
      const tenant = await this.prisma.tenant.findFirst({
        where: { stripeCustomerId: customerId },
        select: {
          id: true,
          name: true,
          currency: true,
          subscriptionStatus: true,
          paymentFailedAt: true,
        },
      });
      if (!tenant) {
        this.logger.warn(
          `No Tenant found for Stripe customer ${customerId}; skipping payment-failed handling.`,
        );
        return;
      }

      // Idempotency: only stamp the grace state on the FIRST
      // payment_failed for a given failure window. Subsequent retries
      // from Stripe (typically over 3-5 days) must not push the
      // gracePeriodEndsAt forward — that would let a tenant keep
      // dodging suspension indefinitely.
      const isFirstFailureForWindow = tenant.subscriptionStatus !== "past_due";
      const now = new Date();
      const gracePeriodEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      await this.prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          subscriptionStatus: "past_due",
          paymentFailedAt: isFirstFailureForWindow ? now : tenant.paymentFailedAt,
          gracePeriodEndsAt: isFirstFailureForWindow
            ? gracePeriodEndsAt
            : undefined, // keep the original window if we're inside it
        },
      });

      if (isFirstFailureForWindow) {
        this.logger.log(
          `Started 7-day grace for tenant ${tenant.name} (${tenant.id}); gracePeriodEndsAt=${gracePeriodEndsAt.toISOString()}`,
        );
      }

      // Notify the tenant owner on every failure so they're
      // repeatedly reminded, not just on the first.
      const owner =
        (await this.prisma.user.findFirst({
          where: { tenantId: tenant.id, role: "owner" },
          select: { email: true, firstName: true },
        })) ??
        (await this.prisma.user.findFirst({
          where: { tenantId: tenant.id, isActive: true },
          orderBy: { createdAt: "asc" },
          select: { email: true, firstName: true },
        }));

      if (!owner?.email) {
        this.logger.warn(
          `Tenant ${tenant.id} (${tenant.name}) has no owner email; skipping payment-failed notification.`,
        );
        return;
      }

      const baseUrl =
        this.configService.get<string>("APP_BASE_URL") ||
        this.configService.get<string>("FRONTEND_URL") ||
        "https://app.kirastudio.com";

      const amountDue =
        typeof invoice.amount_due === "number"
          ? invoice.amount_due / 100
          : 0;
      const retryDate = invoice.next_payment_attempt
        ? new Date(invoice.next_payment_attempt * 1000)
        : undefined;

      await this.email.sendPaymentFailed({
        to: owner.email,
        tenantName: tenant.name,
        amount: amountDue,
        currency: tenant.currency || invoice.currency || "EUR",
        retryDate,
        updatePaymentUrl: `${baseUrl.replace(/\/+$/, "")}/dashboard/billing`,
      });
    } catch (err) {
      // Never let an email failure break the webhook ack — Stripe will
      // retry the event if we return non-2xx.
      this.logger.error(
        `Failed to send payment-failed email for invoice ${invoice.id}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Map a Stripe subscription status onto the lifecycle we model in
 * `tenant_add_ons.status`. Stripe statuses not enumerated here fall
 * through to 'past_due' which keeps the entitlement gated (fail
 * safe) without losing the row -- the next webhook normally clarifies
 * within minutes.
 */
function mapStripeStatus(
  status: Stripe.Subscription.Status,
): 'active' | 'past_due' | 'cancelled' | 'expired' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
      return 'past_due';
    case 'canceled':
      return 'cancelled';
    default:
      return 'past_due';
  }
}
