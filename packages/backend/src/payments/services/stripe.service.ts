import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class StripeService implements OnModuleInit {
  private defaultStripe: Stripe;
  private isEnabled: boolean = false;
  private tenantStripes: Map<string, Stripe> = new Map();
  private tenantEnabled: Map<string, boolean> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    const apiKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    
    if (apiKey && apiKey.startsWith('sk_')) {
      this.defaultStripe = new Stripe(apiKey, {
        apiVersion: '2024-12-18.acacia' as any,
      });
      this.isEnabled = true;
      console.log('[StripeService] Default Stripe payment integration enabled');
    } else {
      console.warn('[StripeService] STRIPE_SECRET_KEY not configured - Stripe payments disabled');
    }
  }

  /**
   * Get Stripe instance for a specific tenant
   * Priority: 1. Tenant-specific keys from database, 2. Default env keys
   */
  async getStripeForTenant(tenantId: string): Promise<{ stripe: Stripe; isEnabled: boolean }> {
    // Check cache first
    if (this.tenantStripes.has(tenantId)) {
      return {
        stripe: this.tenantStripes.get(tenantId)!,
        isEnabled: this.tenantEnabled.get(tenantId) || false,
      };
    }

    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          stripeMode: true,
          stripeTestSecretKey: true,
          stripeLiveSecretKey: true,
        },
      });

      let stripe: Stripe;
      let isEnabled = false;

      if (tenant) {
        const mode = tenant.stripeMode || 'test';
        const secretKey = mode === 'live' ? tenant.stripeLiveSecretKey : tenant.stripeTestSecretKey;

        if (secretKey && secretKey.startsWith('sk_')) {
          stripe = new Stripe(secretKey, {
            apiVersion: '2024-12-18.acacia' as any,
          });
          isEnabled = true;
          console.log(`[StripeService] Tenant ${tenantId} Stripe ${mode} mode enabled`);
        }
      }

      // Fall back to default if no tenant-specific config
      if (!stripe && this.isEnabled) {
        stripe = this.defaultStripe;
        isEnabled = true;
      }

      // Cache the result
      this.tenantStripes.set(tenantId, stripe || this.defaultStripe);
      this.tenantEnabled.set(tenantId, isEnabled);

      return {
        stripe: stripe || this.defaultStripe,
        isEnabled,
      };
    } catch (error) {
      console.error(`[StripeService] Error getting Stripe for tenant ${tenantId}:`, error);
      return {
        stripe: this.defaultStripe,
        isEnabled: this.isEnabled,
      };
    }
  }

  /**
   * Get publishable key for a tenant (for frontend)
   */
  async getPublishableKeyForTenant(tenantId: string): Promise<string | null> {
    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          stripeMode: true,
          stripeTestPublishableKey: true,
          stripeLivePublishableKey: true,
        },
      });

      if (!tenant) {
        return this.configService.get<string>('STRIPE_PUBLISHABLE_KEY') || null;
      }

      const mode = tenant.stripeMode || 'test';
      return mode === 'live' 
        ? tenant.stripeLivePublishableKey 
        : tenant.stripeTestPublishableKey;
    } catch (error) {
      console.error(`[StripeService] Error getting publishable key for tenant ${tenantId}:`, error);
      return this.configService.get<string>('STRIPE_PUBLISHABLE_KEY') || null;
    }
  }

  /**
   * Check if Stripe is enabled (default or tenant-specific)
   */
  async isStripeEnabledForTenant(tenantId: string): Promise<boolean> {
    const { isEnabled } = await this.getStripeForTenant(tenantId);
    return isEnabled;
  }

  /**
   * Legacy method for checking default Stripe
   */
  isStripeEnabled(): boolean {
    return this.isEnabled;
  }

  async createPaymentIntent(
    tenantId: string,
    amount: number,
    clientId?: string,
    appointmentId?: string,
    isDeposit: boolean = false,
  ): Promise<Stripe.PaymentIntent> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    const metadata: Record<string, string> = {
      tenantId,
    };
    
    if (clientId) metadata.clientId = clientId;
    if (appointmentId) metadata.appointmentId = appointmentId;
    if (isDeposit) metadata.isDeposit = 'true';

    return stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: this.configService.get<string>('STRIPE_CURRENCY', 'eur'),
      metadata,
      automatic_payment_methods: {
        enabled: true,
      },
    });
  }

  async createPaymentIntentWithDetails(
    tenantId: string,
    amount: number,
    customerId?: string,
    appointmentId?: string,
    isDeposit: boolean = false,
    description?: string,
  ): Promise<Stripe.PaymentIntent> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    const metadata: Record<string, string> = {
      tenantId,
    };
    
    if (customerId) metadata.clientId = customerId;
    if (appointmentId) metadata.appointmentId = appointmentId;
    if (isDeposit) metadata.isDeposit = 'true';

    return stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: this.configService.get<string>('STRIPE_CURRENCY', 'eur'),
      customer: customerId,
      description: description || (isDeposit ? 'Deposit payment' : 'Appointment payment'),
      metadata,
      automatic_payment_methods: {
        enabled: true,
      },
    });
  }

  async retrievePaymentIntent(tenantId: string, paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.paymentIntents.retrieve(paymentIntentId);
  }

  async updatePaymentIntent(
    tenantId: string,
    paymentIntentId: string,
    data: {
      amount?: number;
      description?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<Stripe.PaymentIntent> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.paymentIntents.update(paymentIntentId, {
      amount: data.amount ? Math.round(data.amount * 100) : undefined,
      description: data.description,
      metadata: data.metadata,
    });
  }

  async cancelPaymentIntent(tenantId: string, paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.paymentIntents.cancel(paymentIntentId);
  }

  async createRefund(
    tenantId: string,
    paymentIntentId: string,
    amount?: number,
    reason?: Stripe.RefundCreateParams.Reason,
  ): Promise<Stripe.Refund> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amount ? Math.round(amount * 100) : undefined,
      reason,
    });
  }

  async createCustomer(
    tenantId: string,
    email: string,
    name: string,
    phone?: string,
  ): Promise<Stripe.Customer> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.customers.create({
      email,
      name,
      phone,
      metadata: {
        tenantId,
      },
    });
  }

  async getCustomer(tenantId: string, customerId: string): Promise<Stripe.Customer> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.customers.retrieve(customerId) as Promise<Stripe.Customer>;
  }

  async updateCustomer(
    tenantId: string,
    customerId: string,
    data: {
      email?: string;
      name?: string;
      phone?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<Stripe.Customer> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.customers.update(customerId, {
      email: data.email,
      name: data.name,
      phone: data.phone,
      metadata: data.metadata,
    });
  }

  async createSubscription(
    tenantId: string,
    customerId: string,
    priceId: string,
    metadata?: Record<string, string>,
  ): Promise<Stripe.Subscription> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      metadata: {
        tenantId,
        ...metadata,
      },
    });
  }

  async cancelSubscription(tenantId: string, subscriptionId: string): Promise<Stripe.Subscription> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.subscriptions.cancel(subscriptionId);
  }

  async getSubscription(tenantId: string, subscriptionId: string): Promise<Stripe.Subscription> {
    const { stripe, isEnabled } = await this.getStripeForTenant(tenantId);
    
    if (!isEnabled) {
      throw new Error('Stripe is not configured for this tenant');
    }

    return stripe.subscriptions.retrieve(subscriptionId);
  }

  /**
   * Construct webhook event from payload and signature
   */
  constructWebhookEvent(
    payload: Buffer | string,
    signature: string,
  ): Stripe.Event {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    }
    return this.defaultStripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );
  }

  /**
   * P2A-receptionist-v2 H-5: open a Stripe Checkout session for an
   * add-on purchase. The UI calls this endpoint, then redirects to
   * `url`. The webhook `customer.subscription.created|updated` with
   * `metadata.kind === 'addon'` provisions the tenant_add_ons row.
   *
   * Metered add-ons (message_bundles) are NOT purchaseable through
   * this path — they go through a separate top-up flow. The caller
   * (tenant-addons.controller) branches on `addOn.metered`.
   */
  async createAddOnCheckout(args: {
    tenantId: string;
    addOnKey: string;
    addOnName: string;
    stripePriceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }> {
    const { stripe, isEnabled } = await this.getStripeForTenant(args.tenantId);
    if (!isEnabled) {
      throw new Error('Stripe is not enabled for this tenant');
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: args.stripePriceId, quantity: 1 }],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      allow_promotion_codes: true,
      metadata: {
        kind: 'addon',
        tenantId: args.tenantId,
        addOnKey: args.addOnKey,
        addOnName: args.addOnName,
      },
      subscription_data: {
        metadata: {
          kind: 'addon',
          tenantId: args.tenantId,
          addOnKey: args.addOnKey,
          addOnName: args.addOnName,
        },
      },
    });
    return { url: session.url ?? '', sessionId: session.id };
  }

  /**
   * Clear tenant cache (useful after updating tenant config)
   */
  clearTenantCache(tenantId: string): void {
    this.tenantStripes.delete(tenantId);
    this.tenantEnabled.delete(tenantId);
  }
}
