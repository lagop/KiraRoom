import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
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
      purchasable: row.purchasable === true,
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
    stripeSubscriptionId?: string | null;
    monthlyPriceCents?: number | null;
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

    // Read before the upsert: the welcome email below fires on the edge
    // into 'active', which the upserted row alone cannot show (it was
    // compared with itself, so the email never went out).
    const before = await this.prisma.tenantAddOn.findUnique({
      where: { tenantId_addOnId: { tenantId: args.tenantId, addOnId: addOn.id } },
      select: { status: true },
    });
    const billing = {
      stripeSubscriptionItemId: args.stripeSubscriptionItemId,
      ...(args.stripeSubscriptionId !== undefined
        ? { stripeSubscriptionId: args.stripeSubscriptionId }
        : {}),
      ...(args.monthlyPriceCents !== undefined
        ? { monthlyPriceCents: args.monthlyPriceCents }
        : {}),
      status: args.status,
      currentPeriodEnd: args.currentPeriodEnd ?? null,
    };
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
        ...billing,
      },
      update: {
        ...billing,
        // A re-purchase after a cancellation is active again.
        ...(args.status === 'active' ? { cancelledAt: null } : {}),
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
    // edge of a purchase: no row before, or a cancelled one bought again.
    // A 'past_due' row that becomes 'active' is a recovered payment, and
    // an 'active' one is a repeated webhook: neither is a new purchase.
    const isPurchase = !before || before.status === 'cancelled';
    if (
      args.status === 'active' &&
      addOn.key === 'multichannel' &&
      isPurchase
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

  // ────────── Purchase from the salon's billing page ──────────

  /**
   * Buys an add-on: one more item, priced from the catalogue, on the
   * salon's plan subscription (SubscriptionsService.addAddOnItem), billed
   * prorated from today. The row is written from what Stripe answers, and
   * the customer.subscription.updated webhook keeps it in sync after that.
   *
   * It used to need a `price_` id typed into the catalogue by hand, which
   * no add-on had, so every purchase was refused; and the Checkout it
   * opened was on the salon's own Stripe account instead of KiraRoom's.
   */
  async purchase(tenantId: string, addOnKey: string): Promise<TenantAddOnRow> {
    const addOn = await this.prisma.addOn.findUnique({ where: { key: addOnKey } });
    if (!addOn || !addOn.isActive) {
      throw new NotFoundException('Ese complemento no existe');
    }
    if (addOn.metered) {
      throw new BadRequestException(
        'Los bonos de mensajes se recargan desde su sección, no se contratan aquí.',
      );
    }
    if (!addOn.purchasable) {
      // Listed as "Próximamente": what it unlocks does not work yet.
      throw new ConflictException(
        `«${addOn.name}» estará disponible próximamente; todavía no se puede contratar.`,
      );
    }
    if (!addOn.monthlyPriceCents || addOn.monthlyPriceCents <= 0) {
      throw new ConflictException(`«${addOn.name}» no tiene precio en el catálogo.`);
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true, subscriptionStatus: true, stripeSubscriptionId: true },
    });
    if (!tenant) throw new NotFoundException('Salón no encontrado');
    if (tenant.subscriptionStatus !== 'active' || !tenant.stripeSubscriptionId) {
      // There is no subscription to add it to: in trial, or not paying.
      throw new BadRequestException(
        'Los complementos se añaden a tu suscripción. Activa tu plan de pago primero.',
      );
    }
    const plan = this.subs.normalizePlan(tenant.plan);
    if (!this.isRelevantForPlan(this.toRow(addOn), plan)) {
      throw new BadRequestException(`Tu plan ya incluye «${addOn.name}».`);
    }

    const existing = await this.prisma.tenantAddOn.findUnique({
      where: { tenantId_addOnId: { tenantId, addOnId: addOn.id } },
    });
    if (existing?.status === 'active') {
      throw new ConflictException(`«${addOn.name}» ya está activo.`);
    }

    const subscription = await this.subs.addAddOnItem({
      tenantId,
      subscriptionId: tenant.stripeSubscriptionId,
      addOnKey: addOn.key,
      addOnName: addOn.name,
      monthlyPriceCents: addOn.monthlyPriceCents,
      currency: addOn.currency,
    });
    await this.syncFromSubscription(subscription);

    const row = await this.prisma.tenantAddOn.findUnique({
      where: { tenantId_addOnId: { tenantId, addOnId: addOn.id } },
    });
    if (!row) {
      // Stripe has the item but it did not come back on the subscription.
      // The webhook will write the row; say so instead of claiming success.
      throw new ConflictException(
        'Stripe aún no ha confirmado el complemento. Recarga la página en unos segundos.',
      );
    }
    return this.toTenantAddOnRow(row);
  }

  /**
   * Stops an add-on. A paid one leaves the Stripe subscription first (with
   * a prorated credit) and is only marked cancelled once Stripe accepted
   * that: it used to be marked cancelled here while Stripe kept billing it.
   * A manual grant has nothing billed and is just ended.
   */
  async cancelForTenant(tenantId: string, addOnKey: string): Promise<{ ok: boolean }> {
    const addOn = await this.prisma.addOn.findUnique({ where: { key: addOnKey } });
    if (!addOn) throw new NotFoundException('Ese complemento no existe');
    const row = await this.prisma.tenantAddOn.findUnique({
      where: { tenantId_addOnId: { tenantId, addOnId: addOn.id } },
    });
    if (!row || row.status === 'cancelled' || row.status === 'expired') {
      throw new NotFoundException(`«${addOn.name}» no está activo.`);
    }
    if (row.stripeSubscriptionItemId) {
      const subscription = await this.subs.removeAddOnItem({
        tenantId,
        itemId: row.stripeSubscriptionItemId,
      });
      if (subscription.metadata?.kind !== 'addon') {
        await this.syncFromSubscription(subscription);
      }
    }
    await this.cancelFromStripe({ tenantId, addOnKey });
    return { ok: true };
  }

  /**
   * Brings tenant_add_ons in line with the add-on items of a plan
   * subscription, as Stripe reports it (webhook or API answer):
   *
   *   - each item with metadata.kind='addon' is provisioned with the
   *     subscription's status (active, or past_due while a payment fails);
   *   - a row that was billed on this subscription and whose item is gone,
   *     or the whole subscription ended, is cancelled.
   *
   * Idempotent: Stripe delivers the same event more than once.
   */
  async syncFromSubscription(subscription: Stripe.Subscription): Promise<void> {
    const tenantId = subscription.metadata?.tenantId;
    if (!tenantId) return;
    const ended =
      subscription.status === 'canceled' || subscription.status === 'incomplete_expired';
    const status = addOnStatusFromStripe(subscription.status);
    const currentPeriodEnd =
      subscription.current_period_end && subscription.current_period_end > 0
        ? new Date(subscription.current_period_end * 1000)
        : null;

    const live = new Set<string>();
    if (!ended) {
      for (const item of subscription.items?.data ?? []) {
        if (item.metadata?.kind !== 'addon') continue;
        const key = item.metadata?.addOnKey;
        if (!key) continue;
        // An item stamped for another salon is not this one's to activate.
        if (item.metadata?.tenantId && item.metadata.tenantId !== tenantId) continue;
        live.add(item.id);
        await this.provisionFromStripe({
          tenantId,
          addOnKey: key,
          stripeSubscriptionItemId: item.id,
          stripeSubscriptionId: subscription.id,
          monthlyPriceCents: item.price?.unit_amount ?? null,
          status,
          currentPeriodEnd,
        });
      }
    }

    const billedHere = await this.prisma.tenantAddOn.findMany({
      where: {
        tenantId,
        stripeSubscriptionId: subscription.id,
        status: { not: 'cancelled' },
      },
      select: { id: true, stripeSubscriptionItemId: true, addOn: { select: { key: true } } },
    });
    for (const row of billedHere) {
      if (row.stripeSubscriptionItemId && live.has(row.stripeSubscriptionItemId)) continue;
      await this.prisma.tenantAddOn.update({
        where: { id: row.id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      this.logger.log(`add-on cancel tenant=${tenantId} key=${row.addOn?.key} (left subscription)`);
      this.metrics
        .counter(COUNTERS.ADDON_CANCELLED, 'Add-on cancelled (Stripe or manual)')
        .inc({ key: row.addOn?.key ?? 'unknown' });
    }
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
      purchasable: row.purchasable === true,
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

/**
 * Map a Stripe subscription status onto the lifecycle we model in
 * `tenant_add_ons.status`. Stripe statuses not enumerated here fall
 * through to 'past_due' which keeps the entitlement gated (fail
 * safe) without losing the row -- the next webhook normally clarifies
 * within minutes.
 */
export function addOnStatusFromStripe(
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
  /** False = "Próximamente": listed, never charged. */
  purchasable: boolean;
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
