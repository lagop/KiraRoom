import { ParseUUIDPipe, Controller, Get, Post, Delete, Body, Param, Query, ForbiddenException, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AddOnsService } from '../services/addons.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SubscriptionsService } from '../services/subscriptions.service';
import {
  AddOnResponseDto,
  AddOnResponseSchema,
  GrantAddOnDto,
  GrantAddOnSchema,
  TenantAddOnResponseDto,
  TenantAddOnResponseSchema,
} from '../dto/addon.dto';

/**
 * SaaS-admin-only add-ons API. Mounted under `/saas/add-ons`.
 *
 * Routes:
 *   GET  /saas/add-ons                          - full catalog (optionally scoped)
 *   GET  /saas/add-ons/tenants/:tenantId        - tenant's installed add-ons
 *   POST /saas/add-ons/tenants/:tenantId        - manually grant (no Stripe)
 *   DELETE /saas/add-ons/tenants/:tenantId/:key - manual revoke (no Stripe)
 *   POST /saas/add-ons/tenants/:tenantId/:key/sync - re-pull state from Stripe
 */
@Controller('saas/add-ons')
@UseGuards(JwtAuthGuard)
export class AddOnsAdminController {
  constructor(
    private readonly addons: AddOnsService,
    private readonly prisma: PrismaService,
    private readonly subs: SubscriptionsService,
  ) {}

  /** Only saas_owner may read or mutate the add-on catalog. */
  private requireSaas(user: { role?: string }) {
    if (user.role !== 'saas_owner') {
      throw new ForbiddenException('SaaS-admin access required');
    }
  }

  @Get()
  async listCatalog(
    @Query('plan') plan: string | undefined,
    @CurrentUser() user: any,
  ): Promise<{ data: AddOnResponseDto[] }> {
    this.requireSaas(user);
    const raw = await this.addons.listCatalog((plan as any) ?? undefined);
    return { data: raw.map((r) => AddOnResponseSchema.parse(r)) };
  }

  /**
   * Per-tenant AI usage for the SaaS-admin dashboard. The tenant
   * currently exposes two relevant fields on `Tenant`:
   *   - aiConversationsUsed  (current month count)
   *   - aiConversationsResetAt
   * Combined with the cap (resolved here from the plan) this gives a
   * "X / 500 conversaciones" gauge for the Esencial segment.
   */
  @Get('tenants/:id/ai-usage')
  async aiUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ): Promise<{
    tenantId: string;
    used: number;
    cap: number | null;
    resetsAt: string | null;
    addonsUnlocked: string[];
  }> {
    this.requireSaas(user);
    const ctx = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        plan: true,
        subscriptionStatus: true,
        trialEnd: true,
        aiConversationsUsed: true,
        aiConversationsResetAt: true,
        tenantAddOns: {
          where: { status: 'active' },
          select: { addOn: { select: { key: true, unlocks: true } } },
        },
      },
    });
    if (!ctx) {
      return { tenantId: id, used: 0, cap: null, resetsAt: null, addonsUnlocked: [] };
    }
    const inTrial =
      ctx.subscriptionStatus === 'trialing' &&
      !!ctx.trialEnd &&
      ctx.trialEnd.getTime() > Date.now();
    const plan = this.subs.effectivePlan(ctx.plan, inTrial);
    const aiConversationsPerMonth = (this.subs.plans as any)[plan]
      ?.aiConversationsPerMonth as number | null | undefined;
    const hasAiExpansion = (ctx.tenantAddOns ?? []).some((a) => {
      const unlocks = a.addOn?.unlocks;
      return Array.isArray(unlocks) && unlocks.includes('virtual_receptionist_advanced');
    });
    const cap = this.subs.resolveEffectiveAiCap(plan, hasAiExpansion);
    const addonsUnlocked: string[] = [];
    for (const row of ctx.tenantAddOns ?? []) {
      const u = row.addOn?.unlocks;
      if (Array.isArray(u)) for (const k of u) addonsUnlocked.push(String(k));
    }
    return {
      tenantId: id,
      used: ctx.aiConversationsUsed ?? 0,
      cap: cap ?? aiConversationsPerMonth ?? null,
      resetsAt: ctx.aiConversationsResetAt?.toISOString() ?? null,
      addonsUnlocked,
    };
  }

  @Get('tenants/:tenantId')
  async tenantAddOns(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
  ): Promise<{ data: TenantAddOnResponseDto[] }> {
    this.requireSaas(user);
    const rows = await this.addons.addonsUnlockedForTenant(tenantId);
    // Pull the full rows for the response (we already have keys, need
    // a join via a separate read for richness).
    const joins = await (
      this.addons as any
    ).prisma.tenantAddOn.findMany({
      where: { tenantId, status: { not: 'expired' } },
      include: { addOn: true },
      orderBy: { startedAt: 'asc' },
    });
    return {
      data: joins.map((row: any) =>
        TenantAddOnResponseSchema.parse({
          id: row.id,
          tenantId: row.tenantId,
          addOn: AddOnResponseSchema.parse(
            this.addons['toRow'](row.addOn),
          ),
          status: row.status,
          isManualGrant: row.stripeSubscriptionItemId === null,
          startedAt: row.startedAt.toISOString(),
          currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
          cancelledAt: row.cancelledAt?.toISOString() ?? null,
        }),
      ),
    };
  }

  @Post('tenants/:tenantId')
  async grant(
    @Param('tenantId') tenantId: string,
    @Body() body: GrantAddOnDto,
    @CurrentUser() user: any,
  ): Promise<TenantAddOnResponseDto> {
    this.requireSaas(user);
    GrantAddOnSchema.parse(body);
    const row = await this.addons.grantManually({
      tenantId,
      addOnKey: body.addOnKey,
      durationDays: body.durationDays,
    });
    if (!row) {
      throw new ForbiddenException('Unknown add-on key');
    }
    // Re-fetch with the add-on row joined for the response.
    return (
      await this.tenantAddOns(tenantId, user)
    ).data.find((r) => r.id === row.id)!;
  }

  @Delete('tenants/:tenantId/:key')
  async revoke(
    @Param('tenantId') tenantId: string,
    @Param('key') key: string,
    @CurrentUser() user: any,
  ): Promise<{ ok: boolean }> {
    this.requireSaas(user);
    const ok = await this.addons.cancelFromStripe({
      tenantId,
      addOnKey: key,
    });
    return { ok };
  }
}
