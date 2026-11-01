import { Injectable, InternalServerErrorException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PlatformStripeConfigService } from '../../platform/platform-stripe-config.service';
import { UpdateStripeSettingsDto, StripeSettingsResponseDto } from '../dto/stripe-settings.dto';
import { maskSecretKey, revealSecretKey, secretKeyChange } from './stripe-keys';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private tenantStripes: Map<string, Stripe> = new Map();
  private tenantEnabled: Map<string, boolean> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    // KiraRoom's account (console, else .env): only the publishable-key
    // fallback below. Salon payments always use the salon's own account.
    private readonly platformStripe: PlatformStripeConfigService,
    // The salon's secret keys are stored encrypted (stripe-keys.ts).
    @Optional() private readonly encryption?: EncryptionService,
  ) {}

  private reveal(stored: string | null | undefined): string | null {
    return revealSecretKey(stored, this.encryption ? (v) => this.encryption!.decrypt(v) : null);
  }

  private seal(plain: string): string {
    if (!this.encryption) return plain;
    try {
      return this.encryption.encrypt(plain);
    } catch (err) {
      this.logger.error(`Cannot encrypt a salon's Stripe key: ${(err as Error).message}`);
      throw new InternalServerErrorException(
        'No se ha podido guardar la clave de forma segura. Inténtalo más tarde o contacta con soporte.',
      );
    }
  }

  /**
   * The salon's Stripe settings for its settings page. The secret keys are
   * never sent: only masked (`sk_live_…1234`) and whether one is saved.
   */
  async getTenantSettings(tenantId: string): Promise<StripeSettingsResponseDto> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        stripeMode: true,
        stripeTestSecretKey: true,
        stripeTestPublishableKey: true,
        stripeLiveSecretKey: true,
        stripeLivePublishableKey: true,
      },
    });
    const mode: 'test' | 'live' = tenant?.stripeMode === 'live' ? 'live' : 'test';
    const testSecret = this.reveal(tenant?.stripeTestSecretKey);
    const liveSecret = this.reveal(tenant?.stripeLiveSecretKey);
    return {
      stripeMode: mode,
      stripeTestSecretKey: maskSecretKey(testSecret),
      stripeTestPublishableKey: tenant?.stripeTestPublishableKey || null,
      stripeLiveSecretKey: maskSecretKey(liveSecret),
      stripeLivePublishableKey: tenant?.stripeLivePublishableKey || null,
      testSecretKeyConfigured: !!testSecret,
      liveSecretKeyConfigured: !!liveSecret,
      isConfigured: mode === 'live' ? !!liveSecret : !!testSecret,
    };
  }

  /**
   * Saves the salon's Stripe settings. A secret key sent back masked (the
   * page shows what it was given) keeps the stored one; an empty one clears
   * it; a new one is checked and stored encrypted.
   */
  async updateTenantSettings(tenantId: string, dto: UpdateStripeSettingsDto) {
    const data: Record<string, string | null> = {};
    if (dto.stripeMode !== undefined) data.stripeMode = dto.stripeMode;

    for (const [field, mode] of [
      ['stripeTestSecretKey', 'test'],
      ['stripeLiveSecretKey', 'live'],
    ] as const) {
      const change = secretKeyChange((dto as Record<string, unknown>)[field], mode);
      if (change.kind === 'clear') data[field] = null;
      if (change.kind === 'set') data[field] = this.seal(change.plain);
    }
    for (const field of ['stripeTestPublishableKey', 'stripeLivePublishableKey'] as const) {
      const value = (dto as Record<string, unknown>)[field];
      if (value === undefined) continue;
      data[field] = typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data,
      select: { stripeMode: true },
    });
    // New keys take effect at once.
    this.clearTenantCache(tenantId);
    return { success: true, stripeMode: updated.stripeMode };
  }

  /**
   * The salon's own Stripe account, from the keys it saved in its settings.
   *
   * It used to fall back to the platform's STRIPE_SECRET_KEY when the salon
   * had none, so a salon's client paid KiraRoom's account. A salon payment
   * now needs the salon's account; without one, Stripe is not enabled.
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
        const secretKey = this.reveal(mode === 'live' ? tenant.stripeLiveSecretKey : tenant.stripeTestSecretKey);

        if (secretKey) {
          stripe = new Stripe(secretKey, {
            apiVersion: '2024-12-18.acacia' as any,
          });
          isEnabled = true;
          this.logger.log(`Tenant ${tenantId} Stripe ${mode} mode enabled`);
        }
      }

      this.tenantStripes.set(tenantId, stripe);
      this.tenantEnabled.set(tenantId, isEnabled);

      return { stripe, isEnabled };
    } catch (error) {
      console.error(`[StripeService] Error getting Stripe for tenant ${tenantId}:`, error);
      return { stripe: undefined as unknown as Stripe, isEnabled: false };
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
        return this.platformStripe.current().publishableKey;
      }

      const mode = tenant.stripeMode || 'test';
      return mode === 'live' 
        ? tenant.stripeLivePublishableKey 
        : tenant.stripeTestPublishableKey;
    } catch (error) {
      console.error(`[StripeService] Error getting publishable key for tenant ${tenantId}:`, error);
      return this.platformStripe.current().publishableKey;
    }
  }

  /**
   * Check if Stripe is enabled (default or tenant-specific)
   */
  async isStripeEnabledForTenant(tenantId: string): Promise<boolean> {
    const { isEnabled } = await this.getStripeForTenant(tenantId);
    return isEnabled;
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
   * Clear tenant cache (useful after updating tenant config)
   */
  clearTenantCache(tenantId: string): void {
    this.tenantStripes.delete(tenantId);
    this.tenantEnabled.delete(tenantId);
  }
}
