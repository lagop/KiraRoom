import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import Stripe from 'stripe';
import { cancelAtOf, checkoutTrialEnd, hasLivePlanSubscription, isAddOnItem, planItemOf } from '../plan-activation';
import { PlatformStripeConfigService } from '../../platform/platform-stripe-config.service';
import { billingCustomerDetails, syncBillingCustomer, syncBillingTaxId } from '../billing-customer';
import { aiConversationsApprox, aiMessageCap, formatCountEs, PLAN_AI_CONVERSATIONS } from '@kira/shared';

/** "500 mensajes al mes, unas 70 conversaciones", as kiraroom.com puts it. */
/** A plan limit with no cap: null in the catalog (-1 in older rows). */
export function isUnlimited(limit: number | null | undefined): boolean {
  return limit === null || limit === undefined || limit === -1;
}

/**
 * What a subscription invoice is for in the list: what was paid once it is
 * paid, what is asked for while it is open or unpaid.
 */
export function invoiceAmount(invoice: { status?: string | null; amount_due: number; amount_paid: number }): number {
  return invoice.status === "open" || invoice.status === "uncollectible" ? invoice.amount_due : invoice.amount_paid;
}

function aiAllowance(messages: number, perLocation = false): string {
  const where = perLocation ? ' por local' : '';
  return `${formatCountEs(messages)} mensajes al mes${where}, unas ${formatCountEs(aiConversationsApprox(messages))} conversaciones`;
}

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

/**
 * Marketing emails a month (one-shot and re-engagement campaigns), per salon;
 * Empresa per billed location (Tenant.maxLocations). Esencial has no
 * campaigns. A bono de emails adds to it (email-campaigns/email-quota.service.ts).
 */
export const EMAIL_MARKETING_MONTHLY_CAP: Readonly<Record<'esencial' | 'pro' | 'empresa', number>> = {
  esencial: 0,
  pro: 2000,
  empresa: 5000,
};

/**
 * Something the salon has above what a plan allows, so it cannot move to
 * that plan until it deactivates the rest (B9). `href` is the panel page
 * where it does so.
 */
export interface PlanLimitBlocker {
  kind: 'professionals' | 'locations';
  current: number;
  limit: number;
  message: string;
  href: string;
}

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
  // WhatsApp promotions (campaigns): Pro and Empresa (and the trial, which is Pro).
  | 'whatsapp_marketing'
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
    'whatsapp_marketing',
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
    'whatsapp_marketing',
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
    'whatsapp_marketing',
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
  advanced: ['whatsapp_notifications','sms_notifications','email_marketing','whatsapp_marketing','virtual_receptionist','loyalty','promotions','gift_cards','wallet','commissions','advanced_analytics','agenda_shifts','multi_location','consolidated_reports','api_access','white_label','custom_branding'],
  enterprise: ['whatsapp_notifications','sms_notifications','email_marketing','whatsapp_marketing','virtual_receptionist','loyalty','promotions','gift_cards','wallet','commissions','advanced_analytics','agenda_shifts','multi_location','consolidated_reports','api_access','white_label','custom_branding'],
};

/** A Stripe Checkout session id, as Stripe puts it in the success URL. */
const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  /**
   * KiraRoom's Stripe account, set in the platform console (else .env).
   * Read on every use, so a new key or a switch to live works at once.
   */
  private get stripe(): Stripe | null {
    return this.platformStripe.client();
  }

  private get isEnabled(): boolean {
    return this.stripe !== null;
  }

  // Define subscription plans (rev 3)
  readonly plans: Record<PlanId, SubscriptionPlanDetails> = {
    esencial: {
      id: 'esencial',
      name: 'Esencial',
      price: 4900, // 49 EUR/month
      features: [
        'Clientas y citas ilimitadas',
        'Hasta 4 profesionales',
        // What the plan does today, nothing more. Verifactu/TicketBAI were
        // listed here when they did not work. WhatsApp reminders work since
        // #110, from the salon's own number. The multichannel receptionist
        // (Messenger/Instagram/Telegram) is not part of Esencial: it is the
        // Multicanal add-on.
        'Facturas con IVA o IGIC',
        `Recepcionista IA en tu web y en WhatsApp: ${aiAllowance(PLAN_AI_CONVERSATIONS.esencial)}`,
        'Agenda online',
        'Recordatorios automáticos por WhatsApp y email',
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
        // Messenger, Instagram and Telegram answer since the multichannel
        // receptionist was built (Messenger/Instagram need KiraRoom's Meta app
        // approved by Meta for pages_messaging / instagram_manage_messages).
        `Recepcionista IA en tu web, WhatsApp, Messenger, Instagram y Telegram: ${aiAllowance(PLAN_AI_CONVERSATIONS.pro)}`,
        'Fidelización, promociones y tarjetas regalo',
        'Campañas de WhatsApp a las clientas que lo aceptan',
        'Wallet y comisiones',
        'Analítica avanzada',
        'Turnos y horarios',
        'Soporte prioritario',
      ],
      maxClients: null,                  // unlimited (was 500 in rev3)
      maxProfessionals: 10,
      maxAppointmentsPerMonth: null,    // unlimited (was 2000 in rev3)
      // Every plan has a cap: see PLAN_AI_CONVERSATIONS in @kira/shared.
      aiConversationsPerMonth: 2000,
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
        // Messenger, Instagram and Telegram answer since the multichannel
        // receptionist was built (Messenger/Instagram need KiraRoom's Meta app
        // approved by Meta for pages_messaging / instagram_manage_messages).
        `Recepcionista IA en tu web, WhatsApp, Messenger, Instagram y Telegram: ${aiAllowance(PLAN_AI_CONVERSATIONS.empresa, true)}`,
        'Todo lo de Pro',
      ],
      maxClients: null,                  // unlimited
      maxProfessionals: null,
      maxAppointmentsPerMonth: null,
      aiConversationsPerMonth: 3000,     // per location
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
    private readonly platformStripe: PlatformStripeConfigService,
  ) {
    this.plans.basic = this.plans.esencial;
    this.plans.professional = this.plans.pro;
    this.plans.advanced = this.plans.empresa;
    this.plans.enterprise = this.plans.empresa;
  }

  // ============ HELPERS ============

  /**
   * Stripe Checkout tax options.
   *
   * Returns the empty object unless tax is on (platform console, else
   * STRIPE_TAX_ENABLED), because
   * automatic_tax needs Stripe Tax active and an origin address configured
   * in the Stripe dashboard. Sending it before that is done makes every
   * checkout fail, so the default is the previous behaviour.
   *
   * With the flag on: Stripe computes Spanish VAT, collects the customer's
   * tax id (the NIF a salon needs to reclaim it), and reverse-charges
   * correctly for EU business customers outside Spain.
   */
  private taxOptions(): Record<string, unknown> {
    // The NIF is asked whatever the tax switch says (B1): a Spanish payer
    // must give it (required "if_supported", Stripe asks it in the
    // countries where it can check one), and Checkout saves the business
    // name and NIF on the customer (customer_update.name, which Stripe
    // requires with tax_id_collection on an existing customer). Whether the
    // prices carry VAT on top (tax_behavior) is still an open decision, so
    // it is not set here.
    const taxId = {
      tax_id_collection: { enabled: true, required: 'if_supported' },
    };
    if (!this.platformStripe.current().taxEnabled) {
      return { ...taxId, customer_update: { name: 'auto' } };
    }
    return {
      automatic_tax: { enabled: true },
      ...taxId,
      customer_update: { name: "auto", address: "auto" },
    };
  }


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
   * The month's AI message cap: the trial's 500, or the plan's (per
   * location on Empresa) plus 1,000 per AI pack add-on. No plan is
   * unlimited any more, and no add-on removes the cap: each message is a
   * paid model call. See aiMessageCap in @kira/shared.
   */
  aiCap(
    plan: string | null | undefined,
    opts: { inTrial: boolean; locations?: number | null; packs?: number },
  ): number {
    return aiMessageCap({ plan: this.normalizePlan(plan) as any, ...opts });
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
    const inTrial =
      tenant.subscriptionStatus === "trialing" &&
      !!tenant.trialEnd &&
      tenant.trialEnd.getTime() > Date.now();
    const cancelAt = tenant.subscriptionCancelAt ?? null;

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
      // Empresa pays per location: the billing page shows how many are
      // paid (maxLocations) against how many are open.
      activeLocations: planId === 'empresa' ? await this.activeLocationCount(tenantId) : null,
      // Cancelled at the end of the paid period: full access until then
      // ("Se cancelará el …", with "Anular cancelación").
      cancelAt,
      cancelAtPeriodEnd: !!cancelAt && tenant.subscriptionStatus !== 'cancelled',
      addons: tenant.addons,
      stripeCustomerId: tenant.stripeCustomerId,
      stripeSubscriptionId: tenant.stripeSubscriptionId,
      planDetails,
      // The plan the salon actually has: Pro during the trial, whatever is
      // stored (a new salon is saved as esencial).
      inTrial,
      effectivePlan: this.effectivePlan(tenant.plan, inTrial),
      // Add-ons are items of the paid subscription (AddOnsService.purchase):
      // in trial, or without a subscription, they cannot be bought yet.
      canBuyAddOns: tenant.subscriptionStatus === "active" && !!tenant.stripeSubscriptionId,
    };
  }

  /**
   * What the whole team's panel needs to know about the plan (B2): the plan
   * in force, the status, the trial and the read-only window, and the
   * add-ons. No Stripe ids, prices or invoices: those stay on the owner's
   * getSubscription. Admins and staff used to get a 403 here, and their
   * panel fell back to "esencial / cancelled": paid features locked on
   * screen and no read-only notice.
   */
  async getSubscriptionContext(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        plan: true,
        subscriptionStatus: true,
        trialEnd: true,
        readOnlyUntil: true,
        cancelledAt: true,
        subscriptionCancelAt: true,
        stripeSubscriptionId: true,
        addons: true,
        tenantAddOns: {
          where: { status: 'active' },
          select: { addOn: { select: { key: true, unlocks: true } } },
        },
      },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    const inTrial =
      tenant.subscriptionStatus === 'trialing' &&
      !!tenant.trialEnd &&
      tenant.trialEnd.getTime() > Date.now();

    const addOnKeys: string[] = [];
    const unlocks = new Set<string>();
    for (const row of tenant.tenantAddOns ?? []) {
      if (row.addOn?.key) addOnKeys.push(row.addOn.key);
      if (Array.isArray(row.addOn?.unlocks)) {
        for (const k of row.addOn.unlocks) if (typeof k === 'string') unlocks.add(k);
      }
    }
    // The legacy JSON column only ever mattered for web_domain; nothing
    // else of it goes out.
    const legacy = (tenant.addons as Record<string, any> | null) ?? {};
    if (legacy?.web_domain?.enabled) unlocks.add('web_domain');

    return {
      plan: this.normalizePlan(tenant.plan),
      effectivePlan: this.effectivePlan(tenant.plan, inTrial),
      status: tenant.subscriptionStatus,
      inTrial,
      trialEnd: tenant.trialEnd,
      readOnlyUntil: tenant.readOnlyUntil,
      cancelledAt: tenant.cancelledAt,
      cancelAt: tenant.subscriptionCancelAt ?? null,
      // A paid subscription exists (it may have been taken in the trial).
      subscribed: !!tenant.stripeSubscriptionId && tenant.subscriptionStatus !== 'cancelled',
      addOns: addOnKeys,
      addOnFeatures: [...unlocks],
    };
  }

  /**
   * Back from a plan checkout (B15): what Stripe says about that session,
   * so the billing page can tell "card saved, first charge on <date>" from
   * "paid", and keep waiting for the webhook only when Stripe has really
   * completed it. Only the salon's own sessions are answered; the plan
   * itself is still applied by the webhook alone.
   */
  async getCheckoutSessionStatus(tenantId: string, sessionId: string) {
    if (!CHECKOUT_SESSION_ID.test(sessionId ?? '')) {
      throw new BadRequestException('Sesión de pago no válida.');
    }
    const stripe = this.requireStripe();
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
    } catch (err) {
      if ((err as { code?: string })?.code === 'resource_missing') {
        throw new NotFoundException('No encontramos esa sesión de pago.');
      }
      throw new ServiceUnavailableException('No hemos podido consultar el pago con Stripe. Vuelve a cargar la página en un momento.');
    }
    const owner = session.metadata?.tenantId ?? session.client_reference_id ?? null;
    if (owner !== tenantId || session.mode !== 'subscription') {
      throw new NotFoundException('No encontramos esa sesión de pago.');
    }

    const subscription =
      session.subscription && typeof session.subscription === 'object'
        ? (session.subscription as Stripe.Subscription)
        : null;
    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : subscription?.id ?? null;
    const trialEndUnix = subscription?.trial_end ?? null;
    const firstChargeAt =
      subscription?.status === 'trialing' && trialEndUnix ? new Date(trialEndUnix * 1000) : null;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeSubscriptionId: true },
    });

    return {
      // open: not finished; complete: card taken (and paid unless in trial); expired.
      status: session.status,
      paymentStatus: session.payment_status,
      plan: this.normalizePlan(session.metadata?.plan),
      // Subscribed during the free trial: nothing charged, the first charge
      // comes the day the trial ends.
      firstChargeAt,
      // The webhook has applied it: the salon's stored subscription is this one.
      applied: !!subscriptionId && tenant?.stripeSubscriptionId === subscriptionId,
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

    if (hasLivePlanSubscription(tenant)) {
      throw new BadRequestException(
        'Ya tienes una suscripción activa: cambia de plan en lugar de contratar otra.',
      );
    }
    // Every salon contracts a plan it fits in (B9), and so does one coming
    // back from cancelled or suspended (D8): the 409 lists how many to
    // deactivate, and deactivating professionals is allowed while
    // read-only (POST /admin/professionals/:id/deactivate). Reactivation
    // goes through here too (reactivateSubscription).
    await this.assertWithinPlanLimits(tenantId, planId);
    const trialEnd = checkoutTrialEnd(tenant, new Date());

    // Empresa bills per location from 1 upwards, and never fewer than the
    // locations the salon has open (B8): it was always 1, so the second
    // location could not be opened. (It once clamped to a minimum of 2,
    // which charged 298 EUR at a checkout advertised as 149 EUR.)
    const quantity = await this.billedLocations(tenantId, planId, locationCount);

    let customerId = tenant.stripeCustomerId;

    // Billed as the razón social, with the NIF and address from Ajustes >
    // Fiscal when the salon has them (B1).
    const billing = billingCustomerDetails(tenant);
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        metadata: {
          tenantId,
        },
        email: tenant.email,
        name: billing.name,
        ...(billing.address ? { address: billing.address } : {}),
      });
      customerId = customer.id;

      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { stripeCustomerId: customerId },
      });
      // Separately and best effort: Stripe refusing the NIF must not stop
      // the checkout (Checkout then asks for it).
      if (billing.taxId) {
        await syncBillingTaxId(this.stripe, customerId, billing.taxId, this.logger);
      }
    } else {
      // The identity may have changed since the customer was created.
      await syncBillingCustomer(this.stripe, customerId, tenant, this.logger);
      // Two plan checkouts left open side by side could both be paid: two
      // subscriptions billing the same salon. Only the newest stays open
      // (the webhook also cancels a second one that gets through).
      await this.expireOpenPlanCheckouts(customerId, tenantId);
    }

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          // product_data, not product: `product` takes the id of an existing
          // Stripe product, so Stripe rejected every checkout built with
          // an inline { name } there.
          price_data: {
            currency: 'eur',
            product_data: {
              name:
                planId === 'empresa'
                  ? `KiraRoom - Empresa (${quantity} locales)`
                  : `KiraRoom - ${planDetails.name} Plan`,
            },
            unit_amount: planDetails.price,
            recurring: {
              interval: 'month',
            },
          } as any,
          quantity,
        },
      ],
      client_reference_id: tenantId,
      metadata: {
        tenantId,
        plan: planId,
        locationCount: String(quantity),
      },
      // The subscription carries the same metadata: its lifecycle events
      // (renewals, failures, cancellation) arrive without the session, and
      // without tenantId the webhook ignored every one of them.
      subscription_data: {
        // In the free trial: card now, first charge when the trial ends.
        ...(trialEnd ? { trial_end: trialEnd } : {}),
        metadata: {
          kind: 'plan',
          tenantId,
          plan: planId,
          locationCount: String(quantity),
        },
      },
      // Stripe fills {CHECKOUT_SESSION_ID} in: the page checks that session
      // on return (getCheckoutSessionStatus) instead of guessing (B15).
      success_url: `${this.configService.get('FRONTEND_URL', 'http://localhost:3000')}/dashboard/billing?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.configService.get('FRONTEND_URL', 'http://localhost:3000')}/dashboard/billing?subscription=cancelled`,
      // VAT: KiraRoom's tax regime charges no VAT or IGIC on its plans
      // (owner's decision D6, 2026-11-04), so the price shown is the final
      // price and Stripe Tax stays off (no tax_behavior either). The NIF is
      // still collected and the customer carries the razón social (B1).
      //
      // Should that change, the switch is here, behind a flag because `automatic_tax` requires Stripe Tax to be
      // switched on and an origin address set in the Stripe dashboard --
      // enabling it in code first makes every checkout fail. Turn it on in
      // Stripe, then turn it on in the platform console (or STRIPE_TAX_ENABLED).
      ...this.taxOptions(),
    });

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
    };
  }

  /**
   * Expires the salon's plan checkouts that are still open. Best effort: a
   * failure here does not stop the new checkout.
   */
  private async expireOpenPlanCheckouts(customerId: string, tenantId: string) {
    try {
      const open = await this.stripe.checkout.sessions.list({
        customer: customerId,
        status: 'open',
        limit: 20,
      });
      for (const session of open?.data ?? []) {
        if (session.mode !== 'subscription') continue;
        if (session.metadata?.tenantId !== tenantId || !session.metadata?.plan) continue;
        await this.stripe.checkout.sessions.expire(session.id);
      }
    } catch (err) {
      console.warn('Could not expire open plan checkouts for tenant', tenantId, err);
    }
  }

  /**
   * The owner cancels: the subscription ends at the END of the period
   * already paid (Stripe cancel_at_period_end, B3). Until then the salon
   * keeps full access and the page says "Se cancelará el <fecha>", with
   * "Anular cancelación" (undoCancellation). When Stripe ends it, the
   * customer.subscription.deleted webhook starts the 30 days of read-only
   * and emails the owner. It used to cancel at once, losing the days
   * already paid.
   *
   * Cancelled at once instead (read-only from now, `newlyCancelled` for
   * the caller's email): without a live subscription (a trial that never
   * subscribed), one Stripe no longer has, one that is not being paid
   * (past_due / suspended: no paid period to keep), or `immediately` (the
   * SaaS console deleting a salon). The local row then changes
   * conditionally: if the webhook of the Stripe cancellation gets in
   * first, it makes the transition and emails instead.
   *
   * Stripe goes first; if it fails, a Spanish 503 and nothing changes, so
   * the owner can try again (B4).
   */
  async cancelSubscription(tenantId: string, immediately: boolean = false) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const paidPeriod =
      !immediately &&
      !!tenant.stripeSubscriptionId &&
      (tenant.subscriptionStatus === 'active' || tenant.subscriptionStatus === 'trialing');
    if (paidPeriod) {
      const scheduled = await this.cancelAtPeriodEndInStripe(tenant);
      if (scheduled) {
        await this.prisma.tenant.update({
          where: { id: tenantId },
          data: {
            subscriptionCancelAt: scheduled.cancelAt,
            ...(scheduled.periodEnd ? { currentPeriodEnd: scheduled.periodEnd } : {}),
          },
        });
        return {
          subscriptionId: tenant.stripeSubscriptionId,
          status: tenant.subscriptionStatus,
          cancelAt: scheduled.cancelAt,
          cancelledAt: null,
          readOnlyUntil: null,
          newlyCancelled: false,
        };
      }
      // Stripe no longer has it: no paid period to keep, cancelled now.
    }

    // Stripe first. A salon marked cancelled here while Stripe kept its
    // subscription was charged every month for an account in read-only (no
    // job reconciled it), and the renewal's webhook reactivated it. If Stripe
    // cannot cancel it now, nothing changes and the owner can try again.
    if (!paidPeriod) await this.cancelInStripe(tenant);

    const now = new Date();
    const readOnlyUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const data = {
      subscriptionStatus: 'cancelled' as const,
      cancelledAt: now,
      readOnlyUntil,
      subscriptionCancelAt: null,
      // plan preserved on purpose (memory for reporting / reactivation)
    };

    const { count } = await this.prisma.tenant.updateMany({
      where: { id: tenantId, subscriptionStatus: { not: 'cancelled' } },
      data,
    });
    const newlyCancelled = count === 1;
    if (!newlyCancelled) {
      // Already cancelled: cancelling again restarts the read-only window.
      await this.prisma.tenant.update({ where: { id: tenantId }, data });
    }

    return {
      subscriptionId: tenant.stripeSubscriptionId,
      status: 'cancelled',
      cancelAt: null,
      cancelledAt: now,
      readOnlyUntil,
      newlyCancelled,
    };
  }

  /**
   * Sets the subscription to end with its paid period. Returns when it
   * ends, or null when Stripe no longer has it (or it has already ended).
   * Any other failure is a Spanish 503 and nothing changes.
   */
  private async cancelAtPeriodEndInStripe(tenant: {
    id: string;
    stripeSubscriptionId: string | null;
    currentPeriodEnd?: Date | null;
  }): Promise<{ cancelAt: Date; periodEnd?: Date } | null> {
    const stripe = this.stripe;
    if (!stripe) {
      throw new ServiceUnavailableException(
        'No se ha podido cancelar la suscripción porque el sistema de pagos no está disponible ahora mismo. No se ha cambiado nada: inténtalo de nuevo en unos minutos.',
      );
    }
    let updated: Stripe.Subscription;
    try {
      updated = await stripe.subscriptions.update(tenant.stripeSubscriptionId as string, {
        cancel_at_period_end: true,
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'resource_missing') return null;
      console.warn('Stripe cancel_at_period_end failed for tenant', tenant.id, err);
      throw new ServiceUnavailableException(
        'No se ha podido cancelar la suscripción en el sistema de pagos. No se ha cambiado nada y no se ha dejado de cobrar: inténtalo de nuevo en unos minutos.',
      );
    }
    if (updated?.status === 'canceled' || updated?.status === 'incomplete_expired') return null;
    const periodEnd =
      typeof updated?.current_period_end === 'number' && updated.current_period_end > 0
        ? new Date(updated.current_period_end * 1000)
        : undefined;
    const cancelAt = (updated ? cancelAtOf(updated) : null) ?? periodEnd ?? tenant.currentPeriodEnd ?? new Date();
    return { cancelAt, periodEnd };
  }

  /**
   * "Anular cancelación": a subscription set to end with its period renews
   * again (cancel_at_period_end: false). Only before it ends: once Stripe
   * has ended it, the salon reactivates through a new checkout. A Stripe
   * failure is a Spanish 503 and nothing changes.
   */
  async undoCancellation(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    if (tenant.subscriptionStatus === 'cancelled' || !tenant.stripeSubscriptionId) {
      throw new ConflictException(
        'Tu suscripción ya ha terminado: para volver, reactiva el plan desde Facturación.',
      );
    }
    const stripe = this.stripe;
    if (!stripe) {
      throw new ServiceUnavailableException(
        'No se ha podido anular la cancelación porque el sistema de pagos no está disponible ahora mismo. No se ha cambiado nada: inténtalo de nuevo en unos minutos.',
      );
    }
    let updated: Stripe.Subscription;
    try {
      updated = await stripe.subscriptions.update(tenant.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });
    } catch (err) {
      console.warn('Stripe undo of cancel_at_period_end failed for tenant', tenantId, err);
      throw new ServiceUnavailableException(
        'No se ha podido anular la cancelación en el sistema de pagos. No se ha cambiado nada: inténtalo de nuevo en unos minutos.',
      );
    }
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { subscriptionCancelAt: null },
    });
    return {
      subscriptionId: updated?.id ?? tenant.stripeSubscriptionId,
      status: tenant.subscriptionStatus,
      cancelAt: null,
    };
  }

  /**
   * Ends the salon's plan subscription in Stripe now, whatever its status
   * here says (a salon suspended from the console is "cancelled" here while
   * Stripe may still charge it). For the console's delete and GDPR erasure:
   * nothing local changes. Returns whether Stripe had one to end; one
   * Stripe no longer has, or has already ended, counts as ended. Any other
   * failure is a Spanish 503 and the caller must not go on.
   */
  async cancelStripeSubscriptionNow(tenantId: string): Promise<{ cancelled: boolean }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, stripeSubscriptionId: true },
    });
    const subscriptionId = tenant?.stripeSubscriptionId;
    if (!subscriptionId) return { cancelled: false };
    const stripe = this.stripe;
    if (!stripe) {
      throw new ServiceUnavailableException(
        'No se ha podido cancelar el cobro porque el sistema de pagos no está disponible ahora mismo. No se ha cambiado nada: inténtalo de nuevo en unos minutos.',
      );
    }
    try {
      await stripe.subscriptions.cancel(subscriptionId);
      return { cancelled: true };
    } catch (err) {
      if ((err as { code?: string })?.code === 'resource_missing') return { cancelled: false };
      // Cancelling one Stripe has already ended is refused: that is fine.
      const current = await stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
      if (current && (current.status === 'canceled' || current.status === 'incomplete_expired')) {
        return { cancelled: false };
      }
      console.warn('Stripe cancel failed for tenant', tenantId, err);
      throw new ServiceUnavailableException(
        'No se ha podido cancelar el cobro en Stripe. No se ha cambiado nada y no se ha dejado de cobrar: inténtalo de nuevo en unos minutos.',
      );
    }
  }

  /**
   * Cancels the tenant's plan subscription in Stripe, or throws a Spanish
   * 503 and leaves everything as it was. Nothing to cancel without a
   * subscription id; one Stripe no longer has counts as cancelled. A salon
   * already cancelled here (cancelling again restarts its read-only window)
   * is not blocked by a failure: its subscription was cancelled before.
   */
  private async cancelInStripe(tenant: {
    id: string;
    subscriptionStatus: string | null;
    stripeSubscriptionId: string | null;
  }) {
    const subscriptionId = tenant.stripeSubscriptionId;
    if (!subscriptionId) return;
    const alreadyCancelled = tenant.subscriptionStatus === 'cancelled';
    const stripe = this.stripe;
    if (!stripe) {
      if (alreadyCancelled) return;
      throw new ServiceUnavailableException(
        'No se ha podido cancelar la suscripción porque el sistema de pagos no está disponible ahora mismo. No se ha cambiado nada: inténtalo de nuevo en unos minutos.',
      );
    }
    try {
      await stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
      if ((err as { code?: string })?.code === 'resource_missing') return;
      console.warn('Stripe cancel failed for tenant', tenant.id, err);
      if (alreadyCancelled) return;
      throw new ServiceUnavailableException(
        'No se ha podido cancelar la suscripción en el sistema de pagos. No se ha cambiado nada y no se ha dejado de cobrar: inténtalo de nuevo en unos minutos.',
      );
    }
  }

  /**
   * Reactivate a previously cancelled subscription.
   *
   * Out of trial it only opens a Stripe Checkout for the salon's plan: the
   * salon stays cancelled (read-only) until the payment's webhook
   * (checkout.session.completed / customer.subscription.created) activates
   * it. It used to switch the salon to `active` and clear read-only before
   * any payment, so closing Stripe's page left it active for free, with its
   * plan card disabled as "Tu plan actual" and no way to pay.
   *
   * Still in the free trial, it returns the salon to `trialing` (nothing to
   * pay yet).
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

    if (inTrial) {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionStatus: 'trialing',
          cancelledAt: null,
          readOnlyUntil: null,
          // Cancelled in Stripe with the subscription; contracting again
          // during the trial starts a new one.
          stripeSubscriptionId: null,
        },
      });
      return { tenantId, status: 'trialing', checkoutUrl: null };
    }

    if (!this.isEnabled) {
      throw new ServiceUnavailableException(
        'El pago no está disponible ahora mismo, así que no se puede reactivar el plan. Inténtalo de nuevo más tarde.',
      );
    }

    // A checkout for the plan it had. The status, read-only window and
    // stored subscription stay as they are until Stripe confirms the
    // payment (the webhook tells this new subscription from the cancelled
    // one by its id).
    const planId = this.normalizePlan(tenant.plan);
    let checkoutUrl: string | null;
    try {
      const session = await this.createCheckoutSession(tenantId, planId);
      checkoutUrl = session.checkoutUrl;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      console.warn('Reactivation checkout failed for tenant', tenantId, err);
      throw new ServiceUnavailableException(
        'No se ha podido abrir la página de pago. Inténtalo de nuevo en unos minutos.',
      );
    }
    if (!checkoutUrl) {
      throw new ServiceUnavailableException(
        'No se ha podido abrir la página de pago. Inténtalo de nuevo en unos minutos.',
      );
    }

    return {
      tenantId,
      status: tenant.subscriptionStatus,
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
    if (tenant.subscriptionCancelAt) {
      throw new ConflictException(
        'Tu suscripción está programada para cancelarse: anula la cancelación antes de cambiar de plan.',
      );
    }
    // Down to a plan the salon does not fit in: refused, with what to
    // deactivate first (B9). Nothing is sent to Stripe.
    await this.assertWithinPlanLimits(tenantId, planId);

    const subscription = await this.stripe.subscriptions.retrieve(
      tenant.stripeSubscriptionId
    );

    // Empresa: one per location open (B8), or more if asked.
    const targetQuantity = await this.billedLocations(tenantId, planId, locationCount);

    // A subscription item's price_data needs the id of an existing product
    // (unlike Checkout, it has no product_data), so the inline { name } it
    // used to send made every plan change fail.
    const product = await this.stripe.products.create({
      name: `KiraRoom - ${planDetails.name}`,
      metadata: { plan: planId },
    });

    const planItem = planItemOf(subscription);
    if (!planItem) {
      throw new NotFoundException('The subscription has no plan item');
    }
    // An add-on the new plan already includes (ai_expansion on Pro) would
    // keep billing for nothing: it leaves the subscription in the same
    // update, and the subscription.updated webhook deactivates it.
    const redundant = await this.addOnItemsCoveredByPlan(subscription, planId);

    const updatedSubscription = await this.stripe.subscriptions.update(
      tenant.stripeSubscriptionId,
      {
        items: [
          ...redundant.map((item) => ({ id: item.id, deleted: true })),
          {
            id: planItem.id,
            price_data: {
              currency: 'eur',
              unit_amount: planDetails.price,
              recurring: { interval: 'month' },
              product: product.id,
            },
            quantity: targetQuantity,
          },
        ],
        metadata: {
          kind: 'plan',
          tenantId,
          plan: planId,
          locationCount: String(targetQuantity),
        },
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
    if (redundant.length > 0) {
      // Stripe already stopped billing them; the webhook says the same.
      await this.prisma.tenantAddOn.updateMany({
        where: {
          tenantId,
          stripeSubscriptionItemId: { in: redundant.map((item) => item.id) },
          status: { not: 'cancelled' },
        },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    }

    return {
      subscriptionId: updatedSubscription.id,
      status: updatedSubscription.status,
      newPlan: planId,
      locationCount: targetQuantity,
      removedAddOns: redundant.map((item) => item.metadata?.addOnKey),
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

    if (!tenant || !tenant.stripeSubscriptionId || tenant.subscriptionStatus === 'cancelled') {
      throw new NotFoundException('No tienes una suscripción activa: contrata el plan Empresa primero.');
    }
    if (this.normalizePlan(tenant.plan) !== 'empresa') {
      throw new BadRequestException('Solo el plan Empresa se paga por local.');
    }
    if (!Number.isInteger(newCount) || newCount < 1) {
      throw new BadRequestException('El plan Empresa incluye al menos 1 local.');
    }
    const active = await this.activeLocationCount(tenantId);
    if (newCount < active) {
      throw new ConflictException(
        `Tienes ${active} locales activos: para pagar ${newCount}, desactiva antes ${active - newCount} en Ajustes > Multi-local.`,
      );
    }

    const subscription = await this.stripe.subscriptions.retrieve(
      tenant.stripeSubscriptionId
    );

    const planItem = planItemOf(subscription);
    if (!planItem) {
      throw new NotFoundException('The subscription has no plan item');
    }

    const updated = await this.stripe.subscriptions.update(
      tenant.stripeSubscriptionId,
      {
        items: [
          {
            // Not items.data[0]: that can be an add-on, whose quantity
            // would have become the number of locations.
            id: planItem.id,
            quantity: newCount,
          },
        ],
        metadata: { ...subscription.metadata, locationCount: String(newCount) },
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

  // ============ PLAN LIMITS ============

  /** Locations open now (closed ones do not count, as when opening one). */
  private async activeLocationCount(tenantId: string): Promise<number> {
    return this.prisma.location.count({ where: { tenantId, isActive: true } });
  }

  /**
   * How many locations a plan subscription bills: 1 outside Empresa; on
   * Empresa the locations open now (at least 1), or more if asked.
   */
  private async billedLocations(tenantId: string, planId: PlanId, requested?: number): Promise<number> {
    if (planId !== 'empresa') return 1;
    const active = await this.activeLocationCount(tenantId);
    return Math.max(1, active, Number.isInteger(requested) ? (requested as number) : 0);
  }

  /**
   * What the salon has above a plan's limits: active professionals over its
   * cap, and active locations over the one a plan other than Empresa
   * includes. The catalogue's other limits (clients, appointments) are
   * unlimited on every plan. Empty when it fits.
   */
  async planLimitBlockers(tenantId: string, plan: string): Promise<PlanLimitBlocker[]> {
    const planId = this.normalizePlan(plan);
    const details = this.plans[planId];
    const name = details?.name ?? planId;
    const blockers: PlanLimitBlocker[] = [];

    const maxProfessionals = details?.maxProfessionals;
    if (!isUnlimited(maxProfessionals)) {
      const limit = maxProfessionals as number;
      const current = await this.prisma.professional.count({ where: { tenantId, isActive: true } });
      if (current > limit) {
        blockers.push({
          kind: 'professionals',
          current,
          limit,
          message: `Tienes ${current} profesionales activos y el plan ${name} permite ${limit}: desactiva ${current - limit} en Equipo > Profesionales.`,
          href: '/dashboard/professionals',
        });
      }
    }

    if (planId !== 'empresa') {
      const current = await this.activeLocationCount(tenantId);
      if (current > 1) {
        blockers.push({
          kind: 'locations',
          current,
          limit: 1,
          message: `Tienes ${current} locales activos y el plan ${name} incluye 1: desactiva ${current - 1} en Ajustes > Multi-local.`,
          href: '/dashboard/multi-location',
        });
      }
    }
    return blockers;
  }

  /** A Spanish 409 listing what to deactivate, when the salon does not fit in the plan. */
  private async assertWithinPlanLimits(tenantId: string, planId: PlanId): Promise<void> {
    const blockers = await this.planLimitBlockers(tenantId, planId);
    if (blockers.length === 0) return;
    const name = this.plans[planId]?.name ?? planId;
    throw new ConflictException({
      code: 'PLAN_LIMITS_EXCEEDED',
      message: `Antes de pasar al plan ${name}: ${blockers.map((b) => b.message).join(' ')}`,
      plan: planId,
      blockers,
    });
  }

  // ============ ADD-ONS ON THE PLAN SUBSCRIPTION ============
  //
  // An add-on is one more item of the salon's plan subscription, priced
  // with price_data like the plan itself (#102): one invoice, one card,
  // prorated when it is added or removed mid-period. The item carries
  // metadata.kind = 'addon' and the add-on key, which is what the
  // customer.subscription.updated webhook activates or deactivates from
  // (AddOnsService.syncFromSubscription).

  /** The platform Stripe account, or a 503 explaining it is missing. */
  private requireStripe(): Stripe {
    if (!this.isEnabled) {
      throw new ServiceUnavailableException(
        'Los pagos con Stripe no están configurados en este entorno.',
      );
    }
    return this.stripe;
  }

  /**
   * Adds the add-on to the subscription and returns the subscription as
   * Stripe has it afterwards. Idempotent: an item for the same add-on that
   * is already there is not added twice (a double click would bill twice).
   */
  async addAddOnItem(args: {
    tenantId: string;
    subscriptionId: string;
    addOnKey: string;
    addOnName: string;
    monthlyPriceCents: number;
    currency: string;
  }): Promise<Stripe.Subscription> {
    const stripe = this.requireStripe();
    const subscription = await stripe.subscriptions.retrieve(args.subscriptionId);
    if (subscription.metadata?.tenantId && subscription.metadata.tenantId !== args.tenantId) {
      throw new BadRequestException('The subscription belongs to another salon');
    }
    const already = (subscription.items?.data ?? []).some(
      (item) => isAddOnItem(item) && item.metadata?.addOnKey === args.addOnKey,
    );
    if (already) return subscription;

    const product = await this.addOnProduct(args.addOnKey, args.addOnName);
    await stripe.subscriptionItems.create({
      subscription: args.subscriptionId,
      // A subscription item's price_data takes an existing product id (no
      // product_data, unlike Checkout).
      price_data: {
        currency: (args.currency || 'EUR').toLowerCase(),
        product,
        unit_amount: args.monthlyPriceCents,
        recurring: { interval: 'month' },
      },
      quantity: 1,
      metadata: { kind: 'addon', addOnKey: args.addOnKey, tenantId: args.tenantId },
      proration_behavior: 'create_prorations',
    });
    return stripe.subscriptions.retrieve(args.subscriptionId);
  }

  /**
   * Stops billing an add-on item. On the plan subscription the item is
   * removed (prorated credit for the unused days). An add-on bought before
   * this change has a subscription of its own; that one is cancelled, after
   * checking it is this salon's add-on subscription and not something else.
   * Returns the subscription as Stripe has it afterwards.
   */
  async removeAddOnItem(args: {
    tenantId: string;
    itemId: string;
  }): Promise<Stripe.Subscription> {
    const stripe = this.requireStripe();
    const item = await stripe.subscriptionItems.retrieve(args.itemId);
    const subscriptionId =
      typeof item.subscription === 'string' ? item.subscription : (item.subscription as any)?.id;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    if (subscription.metadata?.tenantId !== args.tenantId) {
      throw new BadRequestException('The add-on belongs to another salon');
    }
    if (subscription.metadata?.kind === 'addon') {
      return stripe.subscriptions.cancel(subscription.id, { prorate: true });
    }
    if (!isAddOnItem(item)) {
      // Never the plan item: that would leave the salon without a plan.
      throw new BadRequestException('That item is not an add-on');
    }
    await stripe.subscriptionItems.del(args.itemId, {
      proration_behavior: 'create_prorations',
    });
    return stripe.subscriptions.retrieve(subscription.id);
  }

  /**
   * One Stripe product per add-on, with a fixed id, instead of a new
   * product per purchase (changePlan creates one per change).
   */
  private async addOnProduct(addOnKey: string, addOnName: string): Promise<string> {
    const id = `kiraroom_addon_${addOnKey}`;
    try {
      const existing = await this.stripe.products.retrieve(id);
      if (existing?.id) return existing.id;
    } catch (err: any) {
      if (err?.statusCode !== 404 && err?.code !== 'resource_missing') throw err;
    }
    const created = await this.stripe.products.create({
      id,
      name: `KiraRoom - ${addOnName}`,
      metadata: { kind: 'addon', addOnKey },
    });
    return created.id;
  }

  /** Add-on items of the subscription whose every unlock the plan includes. */
  private async addOnItemsCoveredByPlan(
    subscription: Stripe.Subscription,
    planId: PlanId,
  ): Promise<Stripe.SubscriptionItem[]> {
    const items = (subscription.items?.data ?? []).filter(isAddOnItem);
    if (items.length === 0) return [];
    const keys = items.map((item) => String(item.metadata?.addOnKey ?? ''));
    const rows = await this.prisma.addOn.findMany({
      where: { key: { in: keys } },
      select: { key: true, unlocks: true },
    });
    const planFeatures = this.plans[planId]?.featureKeys ?? [];
    const covered = new Set(
      rows
        .filter((row) => {
          const unlocks = Array.isArray(row.unlocks) ? (row.unlocks as string[]) : [];
          return unlocks.length > 0 && unlocks.every((k) => (planFeatures as string[]).includes(k));
        })
        .map((row) => row.key),
    );
    return items.filter((item) => covered.has(String(item.metadata?.addOnKey)));
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
      // An open or unpaid invoice has paid nothing yet: amount_paid showed it
      // as 0,00 €. What it asks for is amount_due; "pending" marks it.
      amount: invoiceAmount(invoice),
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      pending: invoice.status === "open" || invoice.status === "uncollectible",
      currency: invoice.currency,
      status: invoice.status,
      created: new Date(invoice.created * 1000),
      invoiceUrl: invoice.hosted_invoice_url,
      pdfUrl: invoice.invoice_pdf,
    }));
  }

  // ============ FEATURE CHECKS ============

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
          limit: isUnlimited(planDetails.maxClients) ? null : planDetails.maxClients,
          unlimited: isUnlimited(planDetails.maxClients),
        },
        professionals: {
          current: professionalCount,
          limit: isUnlimited(planDetails.maxProfessionals) ? null : planDetails.maxProfessionals,
          unlimited: isUnlimited(planDetails.maxProfessionals),
        },
        appointments: {
          current: appointmentCount,
          limit: isUnlimited(planDetails.maxAppointmentsPerMonth) ? null : planDetails.maxAppointmentsPerMonth,
          unlimited: isUnlimited(planDetails.maxAppointmentsPerMonth),
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