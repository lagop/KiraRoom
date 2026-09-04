import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FeatureFlagService } from '../../common/feature-flags/feature-flag.service';
import { FeatureKey, SubscriptionsService, PlanId } from './subscriptions.service';
import { MetricsService, COUNTERS } from '../../common/observability/metrics.service';
import { EmailService } from '../../notifications/services/email.service';

/**
 * Add-on catalogue + per-tenant entitlement management.
 *
 * Two tables backing this service (see Phase 0 migration
 * `20260721100000_plans_v2_addons`):
 *
 *   add_ons         -> the immutable catalogue row. Seeded in the
 *                      migration (ai_expansion, loyalty_giftcards, ...).
 *                      Edit `unlocks` for new FeatureKey grants.
 *
 *   tenant_add_ons  -> the (tenant, add-on) grant lifecycle.
 *                      `status='active'` means the add-on unlocks apply.
 *                      Other status: 'cancelled', 'expired'.
 *
 * Stripe is the source of truth for the **billing** lifecycle
 * (`stripeSubscriptionItemId`, `currentPeriodEnd`, `cancelledAt`).
 * The webhook layer writes here on every relevant event; this service
 * is what those handlers call.
 *
 * Phase 7 will backfill the legacy `Tenant.addons` Json column so we
 * retire that path. Until then, both sources are read by
 * `feature-flag.service.ts` (union).
 */
@Injectable()
export class AddOnsService {
  private readonly logger = new Logger(AddOnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly subs: SubscriptionsService,
    private readonly metrics: MetricsService,
    private readonly email: EmailService,
  ) {}

  // ────────── Catalog ──────────

  /** Full catalog, sorted by display order. Optionally scoped to a plan. */
  async listCatalog(planFilter?: PlanId): Promise<CatalogEntry[]> {
    const all = await this.prisma.addOn.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
    const entries: CatalogEntry[] = all.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      monthlyPriceCents: row.monthlyPriceCents,
      currency: row.currency,
      unlocks: Array.isArray(row.unlocks)
        ? (row.unlocks as string[])
        : [],
      metered: row.metered,
      stripePriceId: row.stripePriceId,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    }));
    return planFilter
      ? entries.filter((e) => this.isRelevantForPlan(e, planFilter))
      : entries;
  }

  /** Single entry by key, or null. Used by Stripe handlers. */
  async getByKey(key: string): Promise<AddOnRow | null> {
    const row = await this.prisma.addOn.findUnique({
      where: { key },
    });
    if (!row) return null;
    return this.toRow(row);
  }

  /** Resolve all add-on keys currently active for a tenant. */
  async activeAddOnsForTenant(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.tenantAddOn.findMany({
      where: { tenantId, status: 'active' },
      select: { addOn: { select: { key: true } } },
    });
    return rows.map((r) => r.addOn.key);
  }

  /**
   * Compute the FeatureKey union granted by `tenant_add_ons.status='active'`
   * for the given tenant. Plan features come from `SubscriptionsService`.
   * The `feature-flag.service.ts` calls this and unions the result.
   */
  async addonsUnlockedForTenant(tenantId: string): Promise<FeatureKey[]> {
    const rows = await this.prisma.tenantAddOn.findMany({
      where: { tenantId, status: 'active' },
      select: { addOn: { select: { unlocks: true } } },
    });
    const out: FeatureKey[] = [];
    for (const r of rows) {
      if (!Array.isArray(r.addOn.unlocks)) continue;
      for (const k of r.addOn.unlocks as string[]) {
        out.push(k as FeatureKey);
      }
    }
    return out;
  }

  // ────────── Tenant entitlement lifecycle ──────────

  /**
   * Idempotent provisioning. Called from the Stripe webhook on
   * `customer.subscription.created|updated` with
   * `metadata.kind === 'addon'`. The tenant_id and add_on_key must
   * already be present on the SubscriptionItem metadata.
   *
   * Strategy: upsert by `(tenantId, addOnId)`. The previous row is
   * reused so we keep `stripeSubscriptionItemId` consistent across
   * duplicate webhook deliveries (Stripe retries 3+ times).
   */
  async provisionFromStripe(args: {
    tenantId: string;
    addOnKey: string;
    stripeSubscriptionItemId: string;
    status: 'active' | 'past_due' | 'cancelled' | 'expired';
    currentPeriodEnd?: Date | null;
  }): Promise<TenantAddOnRow | null> {
    const addOn = await this.prisma.addOn.findUnique({
      where: { key: args.addOnKey },
    });
    if (!addOn) {
      // Unknown key in the Stripe metadata -- log and skip. Likely a
      // price-row change since the catalog moved. Don't bump the
      // tenant's row count.
      this.logger.warn(
        `provisionFromStripe: unknown add_on_key='${args.addOnKey}' for tenant=${args.tenantId}`,
      );
      return null;
    }

    const result = await this.prisma.tenantAddOn.upsert({
      where: {
        tenantId_addOnId: {
          tenantId: args.tenantId,
          addOnId: addOn.id,
        },
      },
      create: {
        tenantId: args.tenantId,
        addOnId: addOn.id,
        stripeSubscriptionItemId: args.stripeSubscriptionItemId,
        status: args.status,
        currentPeriodEnd: args.currentPeriodEnd ?? null,
      },
      update: {
        stripeSubscriptionItemId: args.stripeSubscriptionItemId,
        status: args.status,
        currentPeriodEnd: args.currentPeriodEnd ?? null,
      },
    });
    this.logger.log(
      `add-on provision tenant=${args.tenantId} key=${args.addOnKey} status=${args.status}`,
    );
    this.metrics
      .counter(COUNTERS.ADDON_PROVISIONED, 'Add-on provisioned (Stripe or manual)')
      // P2A-receptionist-v2 -- this method is the Stripe path; for the
      // manual-grant path we count in `grantManually()` instead.
      .inc({ source: 'stripe', key: args.addOnKey });

    // H-4: send a one-time welcome email when the multichannel
    // add-on transitions to active. We only fire on the active
    // edge: an existing 'past_due' or 'cancelled' row that becomes
    // 'active' (re-activation) is not a new purchase, so we suppress.
    const wasActiveBefore = result.status === args.status && result.status === 'active';
    if (
      args.status === 'active' &&
      addOn.key === 'multichannel' &&
      !wasActiveBefore
    ) {
      await this.sendMultichannelWelcomeEmail(args.tenantId);
    }
    return this.toTenantAddOnRow(result);
  }

  /**
   * H-4: send the "multicanal activated" welcome email. Best-effort
   * — a failed send must NOT roll back the Stripe provisioning. We
   * catch + log and let the controller respond 200 to Stripe.
   */
  private async sendMultichannelWelcomeEmail(tenantId: string): Promise<void> {
    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      if (!tenant) {
        this.logger.warn(
          `multichannel welcome: tenant ${tenantId} not found; skipping`,
        );
        return;
      }
      // The User model doesn't have a back-relation from Tenant, so
      // we query directly. Pick the oldest owner / admin so we have a
      // deterministic recipient.
      const owner = await this.prisma.user.findFirst({
        where: {
          tenantId,
          role: { in: ['owner', 'admin'] },
          isActive: true,
          emailBouncedAt: null,
        },
        orderBy: { createdAt: 'asc' },
        select: { email: true, firstName: true, lastName: true },
      });
      if (!owner?.email) {
        this.logger.warn(
          `multichannel welcome: tenant ${tenantId} has no owner/admin with a clean email; skipping`,
        );
        return;
      }
      const frontendUrl =
        this.config.get<string>('FRONTEND_URL') || 'http://localhost:3000';
      await this.email.sendMultichannelActivated({
        to: owner.email,
        tenantName: tenant.name,
        ownerName: [owner.firstName, owner.lastName].filter(Boolean).join(' '),
        channelsWizardUrl: `${frontendUrl}/dashboard/settings/channels`,
        metaDocsUrl: `${frontendUrl}/docs/h4-multichannel-setup#3-meta--app-review-for-pages_messaging`,
        telegramDocsUrl: `${frontendUrl}/docs/h4-multichannel-setup#4-telegram--botfather-flow`,
      });
      this.logger.log(
        `multichannel welcome email sent to ${owner.email} for tenant ${tenantId}`,
      );
    } catch (err) {
      this.logger.error(
        `multichannel welcome email failed for tenant ${tenantId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Mark an add-on cancelled in our DB but DO NOT delete the row -- we
   * keep the historical stripeSubscriptionItemId + cancelledAt for
   * audit / reactivation. The Stripe webhook for `customer.subscription.deleted`
   * is the canonical trigger.
   */
  async cancelFromStripe(args: {
    tenantId: string;
    addOnKey: string;
    cancelledAt?: Date | null;
  }): Promise<boolean> {
    const addOn = await this.prisma.addOn.findUnique({
      where: { key: args.addOnKey },
    });
    if (!addOn) return false;
    const updated = await this.prisma.tenantAddOn.updateMany({
      where: {
        tenantId: args.tenantId,
        addOnId: addOn.id,
        status: { not: 'cancelled' },
      },
      data: {
        status: 'cancelled',
        cancelledAt: args.cancelledAt ?? new Date(),
      },
    });
    if (updated.count > 0) {
      this.logger.log(
        `add-on cancel tenant=${args.tenantId} key=${args.addOnKey}`,
      );
      this.metrics
        .counter(COUNTERS.ADDON_CANCELLED, 'Add-on cancelled (Stripe or manual)')
        .inc({ key: args.addOnKey });
    }
    return updated.count > 0;
  }

  /**
   * Operator path. The SaaS-admin can gift or revoke an add-on
   * without a Stripe subscription (e.g. trial gifts, promos, beta
   * unlocks). `stripeSubscriptionItemId` stays NULL to mark this.
   */
  async grantManually(args: {
    tenantId: string;
    addOnKey: string;
    durationDays?: number;
  }): Promise<TenantAddOnRow | null> {
    const addOn = await this.prisma.addOn.findUnique({
      where: { key: args.addOnKey },
    });
    if (!addOn) return null;
    const periodEnd = args.durationDays
      ? new Date(Date.now() + args.durationDays * 24 * 60 * 60 * 1000)
      : null;
    const row = await this.prisma.tenantAddOn.upsert({
      where: {
        tenantId_addOnId: { tenantId: args.tenantId, addOnId: addOn.id },
      },
      create: {
        tenantId: args.tenantId,
        addOnId: addOn.id,
        status: 'active',
        stripeSubscriptionItemId: null,
        currentPeriodEnd: periodEnd,
      },
      update: { status: 'active', currentPeriodEnd: periodEnd },
    });
    this.metrics
      .counter(COUNTERS.ADDON_PROVISIONED, 'Add-on provisioned (Stripe or manual)')
      .inc({ source: 'manual', key: args.addOnKey });
    return this.toTenantAddOnRow(row);
  }

  // ────────── Catalog gating ──────────

  /**
   * Should we offer this add-on to a tenant on this plan?
   * Phase 3 placeholder; the full upsell logic lives in
   * `SubscriptionsService.upsellableAddOnsForPlan()`. Kept here so
   * the catalog listing page can filter without import cycles.
   */
  private isRelevantForPlan(entry: CatalogEntry, plan: PlanId): boolean {
    // Today: a metered add-on (message_bundles) is always relevant.
    // A feature-unlocking add-on is suppressed when the plan already
    // grants its unlocks.
    if (entry.metered) return true;
    if (entry.unlocks.length === 0) return true;
    const planFeatures = this.subs.plans[plan]?.featureKeys ?? [];
    const alreadyCovered = entry.unlocks.every((k) =>
      (planFeatures as string[]).includes(k),
    );
    return !alreadyCovered;
  }

  // ────────── Mapping helpers ──────────

  private toRow(row: any): AddOnRow {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      monthlyPriceCents: row.monthlyPriceCents,
      currency: row.currency,
      unlocks: Array.isArray(row.unlocks) ? (row.unlocks as string[]) : [],
      metered: row.metered,
      stripePriceId: row.stripePriceId,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    };
  }

  private toTenantAddOnRow(row: any): TenantAddOnRow {
    return {
      id: row.id,
      tenantId: row.tenantId,
      addOnId: row.addOnId,
      stripeSubscriptionItemId: row.stripeSubscriptionItemId,
      status: row.status,
      startedAt: row.startedAt,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelledAt: row.cancelledAt,
    };
  }
}

export interface CatalogEntry {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyPriceCents: number | null;
  currency: string;
  unlocks: string[];
  metered: boolean;
  stripePriceId: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface AddOnRow extends CatalogEntry {}

export interface TenantAddOnRow {
  id: string;
  tenantId: string;
  addOnId: string;
  stripeSubscriptionItemId: string | null;
  status: 'active' | 'past_due' | 'cancelled' | 'expired';
  startedAt: Date;
  currentPeriodEnd: Date | null;
  cancelledAt: Date | null;
}
