import { Controller, Get, Post, Delete, Param, Req, UseGuards, ForbiddenException } from "@nestjs/common";
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AddOnsService } from '../services/addons.service';
import { MessageBundlesService } from '../../message-bundles/message-bundles.service';
import { SubscriptionsService } from '../services/subscriptions.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Roles, SALON_MANAGERS } from "../../auth/decorators/roles.decorator";
import { SaasOwner } from "../../saas/decorators/saas-owner.decorator";

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
    private readonly bundles: MessageBundlesService,
  ) {}

  /**
   * Catalog filtered by the caller's current plan: redundant add-ons
   * (already included in Pro+) are removed; metered add-ons
   * (message_bundles) are always shown.
   */
  @Get('add-ons/available')
  @Roles(...SALON_MANAGERS)
  async available(@Req() req: any) {
    const tenantId = this.tenantId(req);
    const plan = await this.tenantPlan(tenantId);
    return { data: await this.addons.listCatalog(plan) };
  }

  /** Currently-installed add-ons for this tenant. */
  @Get('tenants/current/add-ons')
  @Roles(...SALON_MANAGERS)
  async installed(@Req() req: any) {
    const tenantId = this.tenantId(req);
    // Return the rows joined with their add-on catalogue row so the
    // UI doesn't need a second round-trip to render the card.
    const rows = await (
      this.addons as any
    ).prisma.tenantAddOn.findMany({
      where: { tenantId, status: { not: 'expired' } },
      include: { addOn: true },
      orderBy: { startedAt: 'asc' } });
    return {
      data: rows.map((row: any) => ({
        id: row.id,
        tenantId: row.tenantId,
        status: row.status,
        isManualGrant: row.stripeSubscriptionItemId === null,
        startedAt: row.startedAt.toISOString(),
        currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        addOn: (this.addons as any).toRow(row.addOn) })) };
  }

  /**
   * Buy an add-on: it becomes an item of the salon's plan subscription,
   * charged prorated from today (AddOnsService.purchase). Refused with the
   * reason for an add-on marked "Próximamente", one the plan already
   * includes, or a salon without a paid subscription. Answers the row as
   * Stripe left it, so the page shows "Activo" only when it is.
   */
  @Post('tenants/current/add-ons/:key')
  @Roles(...SALON_MANAGERS)
  async purchase(@Param('key') key: string, @Req() req: any) {
    const tenantId = this.tenantId(req);
    const row = await this.addons.purchase(tenantId, key);
    return {
      ...row,
      startedAt: row.startedAt?.toISOString?.() ?? row.startedAt,
      currentPeriodEnd: row.currentPeriodEnd?.toISOString?.() ?? null,
      cancelledAt: row.cancelledAt?.toISOString?.() ?? null,
    };
  }

  /** Stop an add-on: removed from the Stripe subscription, then ended here. */
  @Delete('tenants/current/add-ons/:key')
  @Roles(...SALON_MANAGERS)
  async cancel(
    @Param('key') key: string,
    @Req() req: any,
  ) {
    const tenantId = this.tenantId(req);
    return this.addons.cancelForTenant(tenantId, key);
  }

  /** Read the current message bundles balance for this tenant. */
  @Get('message-bundles/tenants/current/balance')
  @Roles(...SALON_MANAGERS)
  async balance(@Req() req: any) {
    const tenantId = this.tenantId(req);
    return this.bundles.getBalance(tenantId);
  }

  /** SaaS-admin manual top-up (used in dev / promo flows). */
  @Post('message-bundles/tenants/current/topup')
  @SaasOwner()
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
      source: 'manual' });
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
      select: { plan: true, subscriptionStatus: true, trialEnd: true } });
    if (!t) return 'esencial';
    const inTrial =
      t.subscriptionStatus === 'trialing' &&
      !!t.trialEnd &&
      new Date(t.trialEnd).getTime() > Date.now();
    return this.subs.effectivePlan(t.plan, inTrial);
  }
}
