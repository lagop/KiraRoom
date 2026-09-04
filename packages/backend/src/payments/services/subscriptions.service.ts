import { Injectable, NotFoundException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import Stripe from 'stripe';

// Public plan ids (rev 3). Legacy aliases are accepted and mapped in helpers
// below so existing tenants + Stripe webhooks keep working.
export type PlanId =
  | 'esencial'
  | 'pro'
  | 'empresa'
  // legacy
  | 'basic'
  | 'professional'
  | 'advanced'
  | 'enterprise';

export const LEGACY_TO_REV3: Record<string, PlanId> = {
  basic: 'esencial',
  professional: 'pro',
  advanced: 'empresa',
  enterprise: 'empresa',
};

export const REV3_PLANS: ReadonlyArray<PlanId> = ['esencial', 'pro', 'empresa'];

export interface CreateSubscriptionDto {
  tenantId: string;
  plan: PlanId;
  paymentMethodId?: string;
  locationCount?: number; // for plan=empresa
}

export interface UpdateSubscriptionDto {
  plan?: PlanId;
  locationCount?: number;
}

export interface SubscriptionPlanDetails {
  id: PlanId;
  name: string;
  price: number; // in cents
  pricePerLocation?: number; // for empresa
  features: string[];
  // null = unlimited. Capacities are capped at the price tier,
  // never by customers (clientes).
  maxClients: number | null;
  maxProfessionals: number | null;
  maxAppointmentsPerMonth: number | null;
  // P2A-receptionist-fairuse -- null = unlimited (Pro+). Esencial defaults to 500.
  aiConversationsPerMonth: number | null;
  featureKeys: ReadonlyArray<FeatureKey>;
  minLocations?: number;
}

export type FeatureKey =
  | 'whatsapp_notifications'
  | 'sms_notifications'
  | 'email_marketing'
  | 'virtual_receptionist'
  // P2A-receptionist-advanced -- Pro+/Enterprise baseline, add-on for Esencial.
  | 'virtual_receptionist_advanced'
  // H-4 multichannel -- Pro+/Empresa only. Esencial stays web-only.
  // Gates both the channels wizard (ChannelsConfigController) and the
  // public Meta/Telegram webhooks, so an Esencial tenant who somehow
  // ends up with a configured pageId/botToken can't be reached.
  | 'multichannel'
  // P2A-reviews-auto -- new add-on gate (google_reviews_auto).
  | 'google_reviews_auto'
  | 'loyalty'
  | 'promotions'
  | 'gift_cards'
  | 'wallet'
  | 'commissions'
  | 'multi_location'
  | 'agenda_shifts'
  | 'consolidated_reports'
  | 'advanced_analytics'
  // P2A-staff-copilot: the in-app assistant for salon staff.
  //   copilot_read  -- Pro+: read-only tools (agenda, stock, top clients).
  //   copilot_write -- Premium/Empresa: write tools (reschedule, send WhatsApp, coupons).
  // Pro tier gets copilot_read; Premium and Empresa get both.
  | 'copilot_read'
  | 'copilot_write'
  // Aparcados (no se exponen comercialmente, sÃ³lo compat)
  | 'api_access'
  | 'white_label'
  | 'custom_branding'
  // Add-on (no es feature de plan, se lee de Tenant.addons)
  | 'web_domain';

/** Feature keys kept in the matrix for backwards compatibility
 * but NOT exposed commercially (plan section 4.9 ""Aparcados"").
 * Filtered out of every public catalog / UI listing. */
export const PARKED_FEATURE_KEYS: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  'api_access',
  'white_label',
  'custom_branding',
]);
// P2A-receptionist-v2 -- exported so the v2 matrix unit test
// (`subscriptions.service.spec.ts`) can lock the matrix. Anything
// exported here is read by `assertEnabled()` in the request path.
export const PLAN_MATRIX: Record<PlanId, ReadonlyArray<FeatureKey>> = {
  esencial: [
    'whatsapp_notifications',
    // P2A-receptionist-base -- IA recepcionista base. Plan-defined
    // aiConversationsPerMonth (500) will be enforced by the upcoming
    // AiConversationCounterService (Phase 2). Until Phase 2 ships
    // DO NOT deploy this matrix change to prod alone -- the cap is
    // decoration until then, and Esencial tenants will incur
    // unlimited LLM cost. Use VIRTUAL_RECEPTIONIST_ESENCIAL_ENABLED
    // config as a kill-switch during the rollout window.
    'virtual_receptionist',
  ],
  pro: [
    'whatsapp_notifications',
    'sms_notifications',
    'email_marketing',
    'virtual_receptionist',
    'virtual_receptionist_advanced',
    'multichannel',
    'loyalty',
    'promotions',
    'gift_cards',
    'wallet',
    'commissions',
    'advanced_analytics',
    'agenda_shifts',
    // P2A-staff-copilot: Pro tier gets the read-only copilot
    // (5 tools per RFC §13: get_my_agenda, get_client_360,
    // get_low_stock, get_top_clients, get_wait_list).
    'copilot_read',
  ],
  empresa: [
    'whatsapp_notifications',
    'sms_notifications',
    'email_marketing',
    'virtual_receptionist',
    'virtual_receptionist_advanced',
    'multichannel',
    'loyalty',
    'promotions',
    'gift_cards',
    'wallet',
    'commissions',
    'advanced_analytics',
    'agenda_shifts',
    'multi_location',
    'consolidated_reports',
    // P2A-staff-copilot: Premium / Empresa gets the full copilot
    // (all 6 read tools + 6 write tools).
    'copilot_read',
    'copilot_write',
    // Aparcados: tÃ©cnicamente construidos; no se ofrecen.
    'api_access',
    'white_label',
    'custom_branding',
  ],
  // legacy fallbacks (mapeo a travÃ©s de LEGACY_TO_REV3 antes de evaluar)
  basic: ['whatsapp_notifications'],
  professional: [
    'whatsapp_notifications',
    'sms_notifications',
    'email_marketing',
    'virtual_receptionist',
    'virtual_receptionist_advanced',
    'loyalty',
    'promotions',
    'gift_cards',
    'wallet',
    'commissions',
    'advanced_analytics',
    'agenda_shifts',
    'copilot_read',
  ],
  advanced: ['whatsapp_notifications','sms_notifications','email_marketing','virtual_receptionist','loyalty','promotions','gift_cards','wallet','commissions','advanced_analytics','agenda_shifts','multi_location','consolidated_reports','api_access','white_label','custom_branding'],
  enterprise: ['whatsapp_notifications','sms_notifications','email_marketing','virtual_receptionist','loyalty','promotions','gift_cards','wallet','commissions','advanced_analytics','agenda_shifts','multi_location','consolidated_reports','api_access','white_label','custom_branding'],
};

@Injectable()
export class SubscriptionsService {
  private stripe: Stripe;
  private isEnabled: boolean = false;

  // Define subscription plans (rev 3)
  readonly plans: Record<PlanId, SubscriptionPlanDetails> = {
    esencial: {
      id: 'esencial',
      name: 'Esencial',
      price: 4900, // 49 EUR/month
      features: [
        'Clientas y citas ilimitadas',
        'Hasta 4 profesionales',
        'Recepcionista IA basica (500 conv./mes)',
        'Agenda online',
        'Recordatorios WhatsApp',
        'Soporte por email',
      ],
      maxClients: null,                  // unlimited (was 150 in rev3)
      maxProfessionals: 4,               // +1 from rev3
      maxAppointmentsPerMonth: null,    // unlimited (was 500 in rev3)
      aiConversationsPerMonth: 500,
      minLocations: 1,
      featureKeys: PLAN_MATRIX.esencial,
    },
    pro: {
      id: 'pro',
      name: 'Pro',
      price: 7900, // 79 EUR/month
      features: [
        'Clientas y citas ilimitadas',
        'Hasta 10 profesionales',
        'Email marketing',
        'Recepcionista IA avanzada (volumen ilimitado)',
        'Multicanal: Messenger, Instagram y Telegram',
        'Loyalty, promociones y gift cards',
        'Wallet y comisiones',
        'Analitica avanzada',
        'Turnos y horarios',
        'Soporte prioritario',
      ],
      maxClients: null,                  // unlimited (was 500 in rev3)
      maxProfessionals: 10,
      maxAppointmentsPerMonth: null,    // unlimited (was 2000 in rev3)
      aiConversationsPerMonth: null,    // unlimited for Pro+
      minLocations: 1,
      featureKeys: PLAN_MATRIX.pro,
    },
    empresa: {
      id: 'empresa',
      name: 'Empresa',
      price: 14900, // â‚¬149/local/month
      pricePerLocation: 14900,
      features: [
        'Multi-local (activable desde 1 local)',
        'Clientas, profesionales y citas ilimitadas por local',
        'Informes consolidados',
        'Panel centralizado',
        'Account manager',
        'Recepcionista IA avanzada (volumen ilimitado)',
        'Todo lo de Pro',
      ],
      maxClients: null,                  // unlimited
      maxProfessionals: null,
      maxAppointmentsPerMonth: null,
      aiConversationsPerMonth: null,
      minLocations: 1,                   // was 2 in rev3
      featureKeys: PLAN_MATRIX.empresa,
    },
    // legacy fallbacks â€“ same shape, mapped to rev3
    basic:      { maxClients: null,       maxProfessionals: null, maxAppointmentsPerMonth: null, aiConversationsPerMonth: null } as unknown as SubscriptionPlanDetails,
    professional: { maxClients: null,    maxProfessionals: null, maxAppointmentsPerMonth: null, aiConversationsPerMonth: null } as unknown as SubscriptionPlanDetails,
    advanced:   { maxClients: null,       maxProfessionals: null, maxAppointmentsPerMonth: null, aiConversationsPerMonth: null } as unknown as SubscriptionPlanDetails,
    enterprise: { maxClients: null,       maxProfessionals: null, maxAppointmentsPerMonth: null, aiConversationsPerMonth: null } as unknown as SubscriptionPlanDetails,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.plans.basic = this.plans.esencial;
    this.plans.professional = this.plans.pro;
    this.plans.advanced = this.plans.empresa;
    this.plans.enterprise = this.plans.empresa;

    const apiKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (apiKey && apiKey.startsWith('sk_')) {
      this.stripe = new Stripe(apiKey, {
        apiVersion: '2024-12-18.acacia' as any,
      });
      this.isEnabled = true;
    }
  }

  // ============ HELPERS ============

  /** Normalize a plan id (legacy aliases -> rev3). */
  normalizePlan(plan: string | null | undefined): PlanId {
    if (!plan) return 'esencial';
    if (plan in LEGACY_TO_REV3) return LEGACY_TO_REV3[plan];
    if (REV3_PLANS.includes(plan as PlanId)) return plan as PlanId;
    return 'esencial';
  }

  /** Compute the effective plan key used to evaluate features. */
  effectivePlan(plan: string | null | undefined, inTrial: boolean): PlanId {
    if (inTrial) return 'pro';
    return this.normalizePlan(plan);
  }

  /**
   * Effective IA fair-use cap for the plan.
   * null = unlimited. Reads from the plan details directly.
   * Use esolveEffectiveAiCap(plan, unlockedAddOns) for the
   * add-on-aware version.
   */
  aiConversationsCapForPlan(plan: PlanId): number | null {
    return this.plans[plan]?.aiConversationsPerMonth ?? null;
  }

  /**
   * Resolves the effective AI cap for a tenant by combining plan + add-ons.
   * The 'ai_expansion' add-on removes the cap entirely, regardless
   * of the plan (works for Esencial primarily; on Pro/Empresa is a no-op).
   */
  resolveEffectiveAiCap(
    plan: PlanId,
    hasAiExpansion: boolean,
  ): number | null {
    const base = this.aiConversationsCapForPlan(plan);
    if (hasAiExpansion) return null; // unlimited when add-on active
    return base;
  }

  /**
   * Adds-on allowed for a given plan. Hidden / disabled from the
   * catalog when the feature is already included in the plan (user
   * would be paying for something they already have).
   *
   * For dev-tools + tests. The richer filter (unlocks[] vs plan
   * featureKeys) used by the real catalog API lives in
   * `AddOnsService.isRelevantForPlan`; this list is intentionally
   * smaller / explicit so unit tests stay deterministic.
   */
  upsellableAddOnsForPlan(plan: PlanId): string[] {
    const all = [
      'ai_expansion',
      'loyalty_giftcards',
      'email_marketing',
      'multichannel',
      'google_reviews_auto',
      'web_domain',
      'deposits_antinoshow',
    ];
    // Filter out add-ons whose unlocks are already covered by the plan.
    // H-4: Pro+ already includes `multichannel` in PLAN_MATRIX, so the
    // Esencial-only multichannel add-on is hidden for them.
    if (plan === 'pro' || plan === 'empresa') {
      return all.filter((k) => k !== 'ai_expansion' && k !== 'multichannel');
    }
    return all;
  }

  isFeatureEnabledForPlan(plan: PlanId, key: FeatureKey): boolean {
    return PLAN_MATRIX[plan]?.includes(key) ?? false;
  }

  // ============ SUBSCRIPTION MANAGEMENT ============

  async getSubscription(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const planId = this.normalizePlan(tenant.plan);
    const planDetails = this.plans[planId];

    return {
      plan: planId,
      legacyPlan: tenant.plan,
      status: tenant.subscriptionStatus,
      currentPeriodStart: tenant.currentPeriodStart,
      currentPeriodEnd: tenant.currentPeriodEnd,
      trialEnd: tenant.trialEnd,
      cancelledAt: tenant.cancelledAt,
      readOnlyUntil: tenant.readOnlyUntil,
      maxLocations: tenant.maxLocations,
      addons: tenant.addons,
      stripeCustomerId: tenant.stripeCustomerId,
      stripeSubscriptionId: tenant.stripeSubscriptionId,
      planDetails,
   };
  }

  async createCheckoutSession(
    tenantId: string,
    plan: string,
    locationCount?: number,
  ) {
    if (!this.isEnabled) {
      throw new Error('Stripe is not configured');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const planId = this.normalizePlan(plan);
    const planDetails = this.plans[planId];
    if (!planDetails) {
      throw new Error('Invalid plan');
    }

    // Empresa requires quantity >= 2
    const quantity = planId === 'empresa'
      ? Math.max(2, locationCount ?? 2)
      : 1;

    let customerId = tenant.stripeCustomerId;

    if (!customerId) {
      const customer = await this.stripe.customers.create({
        metadata: {
          tenantId,
        },
        email: tenant.email,
        name: tenant.name,
      });
      customerId = customer.id;

      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { stripeCustomerId: customerId },
      });
    }

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product: {
              name:
                planId === 'empresa'
                  ? `KiraStudio - Empresa (${quantity} locales)`
                  : `KiraStudio - ${planDetails.name} Plan`,
            },
            unit_amount: planDetails.price,
            recurring: {
              interval: 'month',
            },
          } as any,
          quantity,
        },
      ],
      metadata: {
        tenantId,
        plan: planId,
        locationCount: String(quantity),
      },
      success_url: `${this.configService.get('FRONTEND_URL', 'http://localhost:3000')}/dashboard/billing?subscription=success`,
      cancel_url: `${this.configService.get('FRONTEND_URL', 'http://localhost:3000')}/dashboard/billing?subscription=cancelled`,
    });

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
    };
  }

  async createSubscription(tenantId: string, priceId: string, paymentMethodId?: string) {
    if (!this.isEnabled) {
      throw new Error('Stripe is not configured');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    let customerId = tenant.stripeCustomerId;

    if (!customerId) {
      const customer = await this.stripe.customers.create({
        metadata: { tenantId },
        email: tenant.email,
        name: tenant.name,
      });
      customerId = customer.id;

      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { stripeCustomerId: customerId },
      });
    }

    if (paymentMethodId) {
      await this.stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });

      await this.stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      });
    }

    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      metadata: { tenantId },
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.payment_intent'],
    });

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: 'active',
        plan: 'esencial' as any, // Will be updated when webhook fires
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      },
    });

    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      clientSecret: (subscription.latest_invoice as any)?.payment_intent?.client_secret,
    };
  }

  /**
   * Rev3 cancellation: tenant enters READ-ONLY mode (30 days) and is then
   * archived. The plan field is preserved for historical reporting.
   * Subscription in Stripe is also cancelled.
   */
  async cancelSubscription(tenantId: string, immediately: boolean = false) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const now = new Date();
    const readOnlyUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    if (this.isEnabled && tenant.stripeSubscriptionId) {
      try {
        await this.stripe.subscriptions.cancel(tenant.stripeSubscriptionId);
      } catch (err) {
        // We continue the local cancellation even if Stripe is unreachable;
        // the daily cron / reconciliation job will sync later.
        console.warn('Stripe cancel failed for tenant', tenantId, err);
      }
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionStatus: 'cancelled',
        cancelledAt: now,
        readOnlyUntil,
        // plan preserved on purpose (memory for reporting / reactivation)
      },
    });

    return {
      subscriptionId: tenant.stripeSubscriptionId,
      status: 'cancelled',
      cancelledAt: now,
      readOnlyUntil,
    };
  }

  /**
   * Reactivate a previously cancelled subscription. Clears read-only flags
   * and returns the tenant to `active` (or `trialing` if trialEnd is in the
   * future). If Stripe is configured, opens a new Checkout session.
   */
  async reactivateSubscription(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (tenant.subscriptionStatus !== 'cancelled') {
      return {
        tenantId,
        status: tenant.subscriptionStatus,
        checkoutUrl: null,
      };
    }

    const now = new Date();
    const inTrial = !!tenant.trialEnd && tenant.trialEnd.getTime() > now.getTime();

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionStatus: inTrial ? 'trialing' : 'active',
        cancelledAt: null,
        readOnlyUntil: null,
      },
    });

    // If we have a previous plan, open a checkout for the same plan.
    const planId = this.normalizePlan(tenant.plan);
    let checkoutUrl: string | null = null;
    if (!inTrial) {
      try {
        const session = await this.createCheckoutSession(tenantId, planId);
        checkoutUrl = session.checkoutUrl;
      } catch (err) {
        // Stripe not configured / not enabled â€“ that's ok, tenant is active again.
        console.warn('Reactivation checkout skipped:', err);
      }
    }

    return {
      tenantId,
      status: inTrial ? 'trialing' : 'active',
      checkoutUrl,
    };
  }

  async changePlan(tenantId: string, newPlan: string, locationCount?: number) {
    if (!this.isEnabled) {
      throw new Error('Stripe is not configured');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant || !tenant.stripeSubscriptionId) {
      throw new NotFoundException('No active subscription found');
    }

    const planId = this.normalizePlan(newPlan);
    const planDetails = this.plans[planId];
    if (!planDetails) {
      throw new Error('Invalid plan');
    }

    const subscription = await this.stripe.subscriptions.retrieve(
      tenant.stripeSubscriptionId
    );

    const targetQuantity =
      planId === 'empresa' ? Math.max(2, locationCount ?? 2) : 1;

    const updatedSubscription = await this.stripe.subscriptions.update(
      tenant.stripeSubscriptionId,
      {
        items: [
          {
            id: subscription.items.data[0].id,
            price_data: {
              currency: 'eur',
              unit_amount: planDetails.price,
              recurring: { interval: 'month' },
              product: {
                name:
                  planId === 'empresa'
                    ? `KiraStudio - Empresa (${targetQuantity} locales)`
                    : `KiraStudio - ${planDetails.name} Plan`,
              },
            } as any,
            quantity: targetQuantity,
          },
        ],
        proration_behavior: 'create_prorations',
      }
    );

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        plan: planId as any,
        maxLocations: planId === 'empresa' ? targetQuantity : 1,
      },
    });

    return {
      subscriptionId: updatedSubscription.id,
      status: updatedSubscription.status,
      newPlan: planId,
      locationCount: targetQuantity,
    };
  }

  /**
   * Update only the number of locations for a plan=empresa subscription.
   * Updates the Stripe quantity and reflects it in Tenant.maxLocations.
   */
  async updateLocationCount(tenantId: string, newCount: number) {
    if (!this.isEnabled) {
      throw new Error('Stripe is not configured');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant || !tenant.stripeSubscriptionId) {
      throw new NotFoundException('No active subscription found');
    }
    if (this.normalizePlan(tenant.plan) !== 'empresa') {
      throw new Error('updateLocationCount only valid for plan=empresa');
    }
    if (newCount < 2) {
      throw new Error('Empresa plan requires at least 2 locations');
    }

    const subscription = await this.stripe.subscriptions.retrieve(
      tenant.stripeSubscriptionId
    );

    const updated = await this.stripe.subscriptions.update(
      tenant.stripeSubscriptionId,
      {
        items: [
          {
            id: subscription.items.data[0].id,
            quantity: newCount,
          },
        ],
        proration_behavior: 'create_prorations',
      }
    );

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { maxLocations: newCount },
    });

    return {
      subscriptionId: updated.id,
      locationCount: newCount,
    };
  }

  /**
   * Create a Stripe Customer Portal session so the tenant owner can
   * update their card, billing address, tax ID, view past invoices
   * as PDFs, and manage their email preferences.
   *
   * Returns the portal URL the frontend should window.location to.
   */
  async createBillingPortalSession(tenantId: string, returnUrl: string) {
    if (!this.isEnabled) {
      throw new ServiceUnavailableException(
        "El portal de facturacion de Stripe no esta configurado en este entorno.",
      );
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }
    if (!tenant.stripeCustomerId) {
      throw new BadRequestException(
        "El tenant no tiene un cliente de Stripe asociado. Completa un pago primero.",
      );
    }
    const session = await this.stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  async getInvoices(tenantId: string, limit = 10) {
    if (!this.isEnabled) {
      return [];
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant || !tenant.stripeCustomerId) {
      return [];
    }

    const invoices = await this.stripe.invoices.list({
      customer: tenant.stripeCustomerId,
      limit,
    });

    return invoices.data.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      amount: invoice.amount_paid,
      currency: invoice.currency,
      status: invoice.status,
      created: new Date(invoice.created * 1000),
      invoiceUrl: invoice.hosted_invoice_url,
      pdfUrl: invoice.invoice_pdf,
    }));
  }

  // ============ FEATURE CHECKS ============

  async checkFeature(
    tenantId: string,
    feature: FeatureKey | string,
  ): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      return false;
    }

    if (feature === "web_domain") {
      const addons = (tenant.addons as Record<string, any>) || {};
      return !!addons.web_domain?.enabled;
    }

    if (tenant.subscriptionStatus === "cancelled") {
      return false;
    }

    const inTrial =
      tenant.subscriptionStatus === "trialing" &&
      !!tenant.trialEnd &&
      tenant.trialEnd.getTime() > Date.now();
    const plan = this.effectivePlan(tenant.plan, inTrial);
    return this.isFeatureEnabledForPlan(plan, feature as FeatureKey);
  }

  async getUsageStats(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    const [clientCount, professionalCount, appointmentCount] =
      await Promise.all([
        this.prisma.client.count({ where: { tenantId } }),
        this.prisma.professional.count({ where: { tenantId } }),
        this.prisma.appointment.count({
          where: {
            tenantId,
            createdAt: {
              gte: new Date(
                new Date().getFullYear(),
                new Date().getMonth(),
                1,
              ),
            },
          },
        }),
      ]);

    const inTrial =
      tenant.subscriptionStatus === "trialing" &&
      !!tenant.trialEnd &&
      tenant.trialEnd.getTime() > Date.now();
    const planId = this.effectivePlan(tenant.plan, inTrial);
    const planDetails = this.plans[planId];

    return {
      plan: planId,
      inTrial,
      trialEnd: tenant.trialEnd,
      subscriptionStatus: tenant.subscriptionStatus,
      cancelledAt: tenant.cancelledAt,
      readOnlyUntil: tenant.readOnlyUntil,
      maxLocations: tenant.maxLocations,
      usage: {
        clients: {
          current: clientCount,
          limit: planDetails.maxClients,
          unlimited: planDetails.maxClients === -1,
        },
        professionals: {
          current: professionalCount,
          limit: planDetails.maxProfessionals,
          unlimited: planDetails.maxProfessionals === -1,
        },
        appointments: {
          current: appointmentCount,
          limit: planDetails.maxAppointmentsPerMonth,
          unlimited: planDetails.maxAppointmentsPerMonth === -1,
        },
      },
    };
  }

  /** Catalog exposed to the frontend billing page. */
  getPublicPlans() {
    return REV3_PLANS.map((id) => {
      const p = this.plans[id];
      return {
        id: p.id,
        name: p.name,
        price: p.price,
        pricePerLocation: p.pricePerLocation,
        minLocations: p.minLocations,
        features: p.features,
        // Aparcados (api_access/white_label/custom_branding) se omiten
        // a proposito del catalogo publico (ver PARKED_FEATURE_KEYS).
        featureKeys: p.featureKeys.filter(
          (k) => !PARKED_FEATURE_KEYS.has(k),
        ),
        limits: {
          maxClients: p.maxClients,
          maxProfessionals: p.maxProfessionals,
          maxAppointmentsPerMonth: p.maxAppointmentsPerMonth,
        },
      };
    });
  }
}