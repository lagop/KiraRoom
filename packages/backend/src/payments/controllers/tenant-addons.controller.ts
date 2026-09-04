import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AddOnsService } from '../services/addons.service';
import { MessageBundlesService } from '../../message-bundles/message-bundles.service';
import { SubscriptionsService } from '../services/subscriptions.service';
import { StripeService } from '../services/stripe.service';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Tenant-scoped add-on surface. Distinct from the saas-admin
 * catalog (saas/add-ons) -- these routes are read-write for the
 * authenticated tenant and return the effective `plan ∪ addons`
 * entitlement for THEIR tenant only.
 */
@Controller('payments')
@UseGuards(JwtAuthGuard)
export class TenantAddOnsController {
  constructor(
    private readonly addons: AddOnsService,
    private readonly prisma: PrismaService,
    private readonly subs: SubscriptionsService,
    private readonly stripe: StripeService,
    private readonly bundles: MessageBundlesService,
  ) {}

  /**
   * Catalog filtered by the caller's current plan: redundant add-ons
   * (already included in Pro+) are removed; metered add-ons
   * (message_bundles) are always shown.
   */
  @Get('add-ons/available')
  async available(@Req() req: any) {
    const tenantId = this.tenantId(req);
    const plan = await this.tenantPlan(tenantId);
    return { data: await this.addons.listCatalog(plan) };
  }

  /** Currently-installed add-ons for this tenant. */
  @Get('tenants/current/add-ons')
  async installed(@Req() req: any) {
    const tenantId = this.tenantId(req);
    // Return the rows joined with their add-on catalogue row so the
    // UI doesn't need a second round-trip to render the card.
    const rows = await (
      this.addons as any
    ).prisma.tenantAddOn.findMany({
      where: { tenantId, status: { not: 'expired' } },
      include: { addOn: true },
      orderBy: { startedAt: 'asc' },
    });
    return {
      data: rows.map((row: any) => ({
        id: row.id,
        tenantId: row.tenantId,
        status: row.status,
        isManualGrant: row.stripeSubscriptionItemId === null,
        startedAt: row.startedAt.toISOString(),
        currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        addOn: (this.addons as any).toRow(row.addOn),
      })),
    };
  }

  /**
   * Initiate the purchase. Today this returns a `{ ok: true }` and
   * flips the tenant to a manual grant (a future Stripe Checkout
   * round-trip can be wired in here without an API change).
   */
  @Post('add-ons/:key/checkout')
  async checkout(
    @Param('key') key: string,
    @Body() body: { returnTo?: string } | undefined,
    @Req() req: any,
  ): Promise<{ url: string }> {
    const tenantId = this.tenantId(req);
    const addOn = await this.addons.getByKey(key);
    if (!addOn) throw new NotFoundException('Unknown add-on');
    if (addOn.metered) {
      throw new ForbiddenException(
        'Metered add-ons (e.g. message_bundles) are topped up from the message_bundles section, not here.',
      );
    }
    if (!addOn.stripePriceId) {
      throw new ForbiddenException(
        `Add-on ${addOn.key} has no Stripe price configured yet. Contact support.`,
      );
    }
    // H-4: allow the wizard to redirect the user back to itself after
    // a successful purchase. We strictly validate the path so this
    // can never become an open redirect.
    const returnTo = this.sanitizeReturnTo(body?.returnTo);
    const frontendUrl =
      process.env.FRONTEND_URL || 'http://localhost:3000';
    const baseUrl = `${frontendUrl}/dashboard/billing`;
    const successUrl = returnTo
      ? `${baseUrl}?addOn=${addOn.key}&status=success&returnTo=${encodeURIComponent(returnTo)}`
      : `${baseUrl}?addOn=${addOn.key}&status=success`;
    const cancelUrl = returnTo
      ? `${baseUrl}?addOn=${addOn.key}&status=cancelled&returnTo=${encodeURIComponent(returnTo)}`
      : `${baseUrl}?addOn=${addOn.key}&status=cancelled`;
    const session = await this.stripe.createAddOnCheckout({
      tenantId,
      addOnKey: addOn.key,
      addOnName: addOn.name,
      stripePriceId: addOn.stripePriceId,
      successUrl,
      cancelUrl,
    });
    return { url: session.url };
  }

  @Delete('tenants/current/add-ons/:key')
  async cancel(
    @Param('key') key: string,
    @Req() req: any,
  ) {
    const tenantId = this.tenantId(req);
    const ok = await this.addons.cancelFromStripe({ tenantId, addOnKey: key });
    return { ok };
  }

  /** Read the current message bundles balance for this tenant. */
  @Get('message-bundles/tenants/current/balance')
  async balance(@Req() req: any) {
    const tenantId = this.tenantId(req);
    return this.bundles.getBalance(tenantId);
  }

  /** SaaS-admin manual top-up (used in dev / promo flows). */
  @Post('message-bundles/tenants/current/topup')
  async topup(
    @Req() req: any,
    @Param('key') _key: string,
  ) {
    // In dev the body is { credits: number } from the saas-admin route
    // (mounted under /saas). The tenant-facing route here delegates
    // any credit add to the message-bundles service. For Phase 8 we
    // expose a thin manual grant so the dashboard can simulate a
    // top-up in non-Stripe environments.
    const tenantId = this.tenantId(req);
    const body = (req.body as { credits?: number }) ?? {};
    const credits = Number(body.credits ?? 0);
    if (credits <= 0) {
      throw new ForbiddenException('credits must be > 0');
    }
    const out = await this.bundles.creditTopUp({
      tenantId,
      credits,
      source: 'manual',
    });
    return out;
  }

  // ─── helpers ──────────────────────────────────────────────

  private tenantId(req: any): string {
    const id = req?.user?.tenantId;
    if (!id) {
      throw new ForbiddenException('Tenant context required');
    }
    return id;
  }

  private async tenantPlan(tenantId: string): Promise<any> {
    const t = await (
      this.addons as any
    ).prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true, subscriptionStatus: true, trialEnd: true },
    });
    if (!t) return 'esencial';
    const inTrial =
      t.subscriptionStatus === 'trialing' &&
      !!t.trialEnd &&
      new Date(t.trialEnd).getTime() > Date.now();
    return this.subs.effectivePlan(t.plan, inTrial);
  }

  /**
   * H-4: validate the optional `returnTo` path supplied by the wizard.
   * Only accepts same-origin absolute paths starting with `/dashboard/`
   * (no external URLs, no protocols, no hash/JS). Anything else is
   * dropped silently — defense against open-redirect via a tampered
   * Stripe success URL.
   */
  private sanitizeReturnTo(raw: string | undefined): string | null {
    if (!raw || typeof raw !== 'string') return null;
    if (raw.length > 256) return null;
    if (!raw.startsWith('/')) return null;
    if (raw.startsWith('//')) return null;
    if (/[\r\n]/.test(raw)) return null;
    // Block javascript: and data: URI smuggling via fragments.
    if (/javascript:/i.test(raw) || /data:/i.test(raw)) return null;
    // Only allow known app routes. This is the smallest allow-list
    // that covers every existing entry point the wizard sends users to.
    const allowed = [
      '/dashboard',
      '/dashboard/settings',
      '/dashboard/settings/channels',
      '/dashboard/billing',
    ];
    if (!allowed.some((p) => raw === p || raw.startsWith(p + '/'))) return null;
    return raw;
  }
}
