import { ParseUUIDPipe, Controller, Post, Get, Req, Body, Param, Query, UseGuards, ValidationPipe, Logger, ForbiddenException } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureGuard } from '../common/guards/feature.guard';
import { Feature } from '../common/decorators/feature.decorator';
import { AssistantService } from './assistant.service';
import { ActionApprovalService } from './action-approval.service';
import { AssistantTierService } from './assistant-tier.service';
import { AssistantSoftLaunchGuard } from './assistant-soft-launch.guard';
import {
  SendAssistantMessageSchema,
  CreateAssistantConversationSchema,
  ApprovalActionSchema,
  type SendAssistantMessageDto,
  type CreateAssistantConversationDto,
  type ApprovalActionDto,
} from '@kira/shared';

interface AuthedRequest {
  user: { id: string; tenantId: string; role: string };
}

/**
 * REST API for the in-app staff copilot. All endpoints are JWT-guarded
  * and scoped to (userId, tenantId) — a user can only see their own
  * conversation, their own approvals, etc. The copilot is never
  * shared with the customer-side Virtual Receptionist.
 */
@ApiTags('staff-copilot')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard, AssistantSoftLaunchGuard)
// P2A-staff-copilot: allow all non-client roles. The `manager` and
// `receptionist` values come from the JWT payload and are mapped to
// `admin` / `staff` at the service layer (these positions are not in
// the Prisma UserRole enum yet — see the sprint 13 follow-up to add
// them).
@Roles('owner', 'admin', 'staff', 'saas_owner' as any)
@Controller('assistant')
export class AssistantController {
  private readonly logger = new Logger(AssistantController.name);

  constructor(
    private readonly assistantService: AssistantService,
    private readonly approvals: ActionApprovalService,
    private readonly tiers: AssistantTierService,
  ) {}

  @Post('conversations')
  @ApiOperation({ summary: 'Get-or-create the persistent staff-copilot conversation for the calling user' })
  async createConversation(
    @Req() req: AuthedRequest,
    @Body(new ValidationPipe()) body: CreateAssistantConversationDto,
  ) {
    return this.assistantService.getOrCreateConversation(
      req.user.id,
      req.user.tenantId,
      body.title,
    );
  }

  @Get('conversations')
  @ApiOperation({ summary: 'List the calling user\'s staff-copilot conversations' })
  async listConversations(@Req() req: AuthedRequest) {
    return this.assistantService.listConversations(req.user.id, req.user.tenantId);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Page through the messages of a staff-copilot conversation' })
  async listMessages(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.assistantService.listMessages(id, req.user.id);
  }

  @Post('messages')
  @Feature('copilot_read' as any)
  // P2A-staff-copilot-sprint15: 60 messages / minute / user (RFC §10.2).
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiOperation({ summary: 'Send a user message; the LLM replies with grounded salon data' })
  async sendMessage(
    @Req() req: AuthedRequest,
    @Body(new ValidationPipe()) body: SendAssistantMessageDto,
  ) {
    const dto: SendAssistantMessageDto = body;
    return this.assistantService.sendMessage(
      {
        id: req.user.id,
        tenantId: req.user.tenantId,
        role: req.user.role,
      },
      dto,
    );
  }

  /**
   * P2A-copilot-sprint13: the "good morning" briefing for the calling
   * user. Returns today's appointments + pending confirmations + gaps
   * + low-stock + at-risk clients, all scoped to the caller's role.
   * Consumed by the `<BriefingCard />` on the panel.
   */
  @Get('insights/daily')
  @Feature('copilot_read' as any)
  @ApiOperation({ summary: 'Daily briefing for the calling user' })
  async dailyBriefing(@Req() req: AuthedRequest) {
    return this.assistantService.getDailyBriefing({
      id: req.user.id,
      tenantId: req.user.tenantId,
      role: req.user.role,
    });
  }

  /**
   * P2A-staff-copilot-sprint15: the tenant's effective copilot tier
   * and the tool sets that tier unlocks. Consumed by the panel to
   * decide whether to show the upgrade prompt on a fresh open.
   */
  @Get('tier')
  @ApiOperation({ summary: 'Effective copilot tier + tool sets for the calling tenant' })
  async getTier(@Req() req: AuthedRequest) {
    const tenantId = req.user.tenantId;
    const tier = await this.tiers.resolveTier(tenantId);
    const [readTools, writeTools] = await Promise.all([
      this.tiers.allowedReadTools(tenantId),
      this.tiers.allowedWriteTools(tenantId),
    ]);
    return { tier, readTools, writeTools };
  }

  /**
   * P2A-staff-copilot-sprint15: monthly usage stats for the
   * admin/debug panel. Returns message counts, action counts,
   * top users, and the cost-protection flag.
   */
  @Get('usage')
  @Feature('copilot_read' as any)
  @ApiOperation({ summary: 'Monthly copilot usage stats for the calling tenant' })
  async getUsage(@Req() req: AuthedRequest) {
    const tenantId = req.user.tenantId;
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);

    const [messageCount, actionCount, topUsers, approvalRate, overCap] =
      await Promise.all([
        this.assistantService['prisma'].assistantMessage.groupBy({
          by: ['role'],
          where: { conversation: { tenantId }, createdAt: { gte: start } },
          _count: { _all: true },
        }),
        this.assistantService['prisma'].actionApproval.count({
          where: { tenantId, createdAt: { gte: start } },
        }),
        this.assistantService['prisma'].assistantMessage.groupBy({
          by: ['conversationId'],
          where: { conversation: { tenantId }, createdAt: { gte: start } },
          _count: { _all: true },
          orderBy: { _count: { conversationId: 'desc' } },
          take: 5,
        }),
        this.assistantService['prisma'].actionApproval.groupBy({
          by: ['status'],
          where: { tenantId, createdAt: { gte: start } },
          _count: { _all: true },
        }),
        this.tiers.isOverCostCap(tenantId),
      ]);

    return {
      month: start.toISOString().slice(0, 7),
      messages: messageCount.reduce(
        (acc: any, r: any) => ({ ...acc, [r.role]: r._count._all }),
        {} as Record<string, number>,
      ),
      actionsTotal: actionCount,
      approvalBreakdown: approvalRate.reduce(
        (acc: any, r: any) => ({ ...acc, [r.status]: r._count._all }),
        {} as Record<string, number>,
      ),
      topConversations: topUsers.map((u: any) => ({
        conversationId: u.conversationId,
        messages: u._count._all,
      })),
      overCostCap: overCap,
    };
  }

  // ----------------------------------------------------------------
  //  Sprint 14: ActionApproval endpoints
  // ----------------------------------------------------------------

  @Get('approvals')
  @Feature('copilot_read' as any)
  @ApiOperation({ summary: 'List pending approvals for the calling user' })
  async listApprovals(@Req() req: AuthedRequest) {
    return this.approvals.listForUser(req.user.id, req.user.tenantId);
  }

  @Get('approvals/:id')
  @Feature('copilot_read' as any)
  @ApiOperation({ summary: 'Approval detail (preview, tool, input, expiresAt)' })
  async getApproval(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.approvals.getForUser(id, req.user.id);
  }

  @Post('approvals/:id/resolve')
  @Feature('copilot_write' as any)
  // Sprint 15: 5 actions / minute / user (RFC §10.2).
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Approve or reject a pending action' })
  async resolveApproval(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ValidationPipe()) body: ApprovalActionDto,
  ) {
    if (body.action === 'approve') {
      return this.approvals.approveAndExecute(id, req.user.id, {
        tenantId: req.user.tenantId,
        userId: req.user.id,
        role: req.user.role,
      });
    }
    return this.approvals.reject(id, req.user.id, body.reason);
  }

  // ----------------------------------------------------------------
  //  Sprint 16 — SaaS platform admin reporting
  // ----------------------------------------------------------------

  /**
   * Per-tenant copilot usage aggregated for the SaaS admin dashboard.
   * Returns one row per tenant that used the copilot in the requested
   * month, with message counts, action counts and the cost-protection
   * flag. Used by the platform team to monitor adoption during the
   * soft-launch.
   *
   * `month` is optional and defaults to the current calendar month
   * (`YYYY-MM`). The endpoint requires `saas_owner` on the JWT — we
   * check it inline (cheap) rather than wiring a dedicated guard for
   * this single endpoint.
   */
  @Get('saas/admin/assistant/usage')
  @ApiOperation({ summary: 'SaaS admin: per-tenant copilot usage for a month' })
  async saasUsage(
    @Req() req: AuthedRequest,
    @Query('month') month?: string,
  ) {
    if (req.user.role !== 'saas_owner') {
      throw new ForbiddenException('SaaS admin only');
    }

    const yyyymm = month ?? (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    const [yearStr, monthStr] = yyyymm.split('-');
    const year = Number(yearStr);
    const monthIdx = Number(monthStr);
    if (!Number.isFinite(year) || !Number.isFinite(monthIdx) || monthIdx < 1 || monthIdx > 12) {
      throw new ForbiddenException(`Invalid month: ${month}. Expected YYYY-MM.`);
    }
    const start = new Date(Date.UTC(year, monthIdx - 1, 1));
    const end = new Date(Date.UTC(year, monthIdx, 1));

    // Tenants with any copilot activity in the month.
    const tenantIds = await this.assistantService['prisma'].assistantMessage.findMany({
      where: {
        conversation: { tenantId: { not: '' } },
        createdAt: { gte: start, lt: end },
      },
      select: { conversation: { select: { tenantId: true } } },
      distinct: ['conversationId'],
    });
    const ids = Array.from(new Set(tenantIds.map((r: any) => r.conversation.tenantId)));

    if (ids.length === 0) {
      return { month: yyyymm, totalTenants: 0, tenants: [] };
    }

    const [tenants, msgAggs, actionAggs] = await Promise.all([
      this.assistantService['prisma'].tenant.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          plan: true,
          subscriptionStatus: true,
          aiConversationsUsed: true,
        },
      }),
      this.assistantService['prisma'].assistantMessage.groupBy({
        by: ['conversationId'],
        where: {
          conversation: { tenantId: { in: ids } },
          createdAt: { gte: start, lt: end },
          role: { in: ['user', 'assistant'] },
        },
        _count: { _all: true },
      }),
      this.assistantService['prisma'].actionApproval.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, createdAt: { gte: start, lt: end } },
        _count: { _all: true },
      }),
    ]);

    // Aggregate messages by tenantId.
    const conversationsByTenant = await this.assistantService['prisma'].assistantConversation
      .findMany({
        where: { tenantId: { in: ids }, createdAt: { gte: start, lt: end } },
        select: { id: true, tenantId: true },
      });
    const convTenantMap = new Map<string, string[]>();
    for (const c of conversationsByTenant) {
      if (!convTenantMap.has(c.tenantId)) convTenantMap.set(c.tenantId, []);
      convTenantMap.get(c.tenantId)!.push(c.id);
    }
    const convIdToTenant = new Map(conversationsByTenant.map((c) => [c.id, c.tenantId]));
    const messagesByTenant = new Map<string, number>();
    for (const m of msgAggs) {
      const t = convIdToTenant.get(m.conversationId);
      if (t) messagesByTenant.set(t, (messagesByTenant.get(t) ?? 0) + m._count._all);
    }

    const actionsByTenant = new Map<string, number>();
    for (const a of actionAggs) {
      actionsByTenant.set(a.tenantId, a._count._all);
    }

    // Approx cost: same model as AssistantTierService.isOverCostCap.
    const PREMIUM_FEE_EUR = 99;
    const tenantRows = tenants.map((t: any) => {
      const messages = messagesByTenant.get(t.id) ?? 0;
      const actions = actionsByTenant.get(t.id) ?? 0;
      const approxCostEur = messages * 0.02 + actions * 0.05;
      return {
        tenantId: t.id,
        name: t.name,
        plan: t.plan,
        subscriptionStatus: t.subscriptionStatus,
        activeConversations: (convTenantMap.get(t.id) ?? []).length,
        messages,
        actions,
        approxCostEur: Number(approxCostEur.toFixed(2)),
        costCapTriggered: approxCostEur > PREMIUM_FEE_EUR * 3,
        // The counter is cumulative (resets on the cron), so it's a
        // separate signal from the per-month aggregates above.
        cumulativeCounter: t.aiConversationsUsed,
      };
    });
    tenantRows.sort((a, b) => b.messages - a.messages);

    return {
      month: yyyymm,
      totalTenants: tenantRows.length,
      totalMessages: tenantRows.reduce((s, r) => s + r.messages, 0),
      totalActions: tenantRows.reduce((s, r) => s + r.actions, 0),
      totalApproxCostEur: Number(
        tenantRows.reduce((s, r) => s + r.approxCostEur, 0).toFixed(2),
      ),
      tenants: tenantRows,
    };
  }
}
