import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { incrementAiUsage } from '../common/ai-usage/ai-monthly-usage';
import { LLMService } from '../virtual-receptionist/services/llm.service';
import {
  buildCopilotSystemPrompt,
  type CopilotPromptContext,
} from './copilot-system-prompt';
import {
  SendAssistantMessageDto,
  AssistantSendResponse,
  AssistantConversationPublic,
  AssistantMessagePublic,
} from '@kira/shared';
import { SalonCopilotToolsService, COPILOT_TOOLS } from './tools/salon-copilot-tools';
import { ActionApprovalService } from './action-approval.service';
import { AssistantTierService } from './assistant-tier.service';
import { VISIT_ROW_ORDER, minutesUntilFree } from '../appointments/visit-totals';
import { addDays, salonToday } from '../analytics/analytics-metrics';
import { safeTimeZone } from '../gift-cards/gift-card-expiry';
import { timeOffBetween } from '../time-off/time-off-query';
import { briefingGaps, salonNowMinutes } from './briefing-gaps';
import { clientScopeWhere } from '../clients/clients.service';

/**
 * P2A-staff-copilot sprint 16 — billing hook.
 *
 * Each LLM-driven assistant turn increments `Tenant.aiConversationsUsed`
 * by 1 (the same counter the customer chatbot uses, so a single
 * `Tenant` row aggregates all AI usage for billing / fair-use
 * dashboards). Each `ActionApproval` creation also increments by 1
 * (write actions cost the salon more than reads, both in LLM tokens
 * and in the audit-log work they generate downstream).
 *
 * The increment uses Prisma's atomic `increment` operator so it's
 * safe under concurrent calls. We do NOT call the virtual-receptionist
 * `AiConversationCounterService` directly — that module is wired for
 * the chatbot and uses Redis shadowing we don't need here. For the
 * soft-launch (≤10 tenants) Postgres-only is fine; we can graduate to
 * the shared counter when the volume justifies it.
 */
async function bumpUsageCounter(prisma: PrismaService, tenantId: string, by = 1): Promise<number> {
  // This month's count: a new month starts again from 0.
  return incrementAiUsage(prisma, tenantId, by);
}

/**
 * Tools that ALWAYS require human approval before running. The
 * orchestrator detects these names and produces a pending_action
 * envelope instead of executing the tool synchronously.
 */
const WRITE_TOOLS = new Set<string>([
  'draft_follow_up_message',
  'send_message',
  'reschedule_appointment',
  'mark_no_show',
  'create_coupon',
  'close_waitlist_slot',
]);

/**
 * Tool-specific preview copy. Keep these short (one sentence) so the
 * panel can render them inline. The LLM still gets to add its own
 * wording on top of the preview; the preview is just the canonical
 * "what will happen" line.
 */
export const TOOL_PREVIEW: Record<string, (input: any) => string> = {
  draft_follow_up_message: (i) => {
    const channel = (i?.channel as string) ?? 'whatsapp';
    const occasion = (i?.occasion as string) ?? 'confirmation';
    return `Redactar un ${channel === 'email' ? 'email' : 'WhatsApp'} de ${occasion} para la clienta (no se envía hasta tu aprobación).`;
  },
  send_message: (i) => {
    const name = i?.templateName ?? 'plantilla';
    return `Enviar WhatsApp usando la plantilla "${name}". El envío queda registrado en la auditoría.`;
  },
  reschedule_appointment: (i) => {
    const d = i?.newDate ?? '';
    const t = i?.newTime ?? '';
    return `Mover la cita a ${d} ${t}.`;
  },
  mark_no_show: (i) => {
    const fee = i?.applyFee ? ` y aplicar ${i.feeAmount}€ de penalización` : '';
    return `Marcar la cita como no-show${fee}.`;
  },
  create_coupon: (i) => {
    const pct = i?.discountPercent ?? '?';
    const days = Math.min(Math.max(Math.round(Number(i?.expiresInDays ?? 30)) || 30, 1), 365);
    return `Crear un código de descuento del ${pct}% para cualquier clienta, de un solo uso y válido ${days === 1 ? 'hoy' : `${days} días`}. Se aplica al cobrar en caja (no en la reserva online).`;
  },
  close_waitlist_slot: (i) => {
    const n = i?.topN ?? 5;
    return `Avisar por email, WhatsApp o SMS a los ${n} primeros clientes de la lista de espera que encajen con el hueco (solo cuenta como avisado si le llega).`;
  },
};

/**
 * P2A-staff-copilot: the orchestrator for the in-app copilot.
 *
 * In sprint 12 this is read-only — it answers questions about the
 * salon's day, clients, and stock, but never writes. The user always
 * gets the data they asked for and a follow-up suggestion. The
 * write side (sprint 14+) goes through `ActionApprovalService` and
 * is not part of this file.
 *
 * The architecture mirrors `VirtualReceptionistService` but is
 * intentionally slimmer: no intent dispatcher (the LLM picks
 * tools itself based on the system prompt), no booking flow, no
 * channel dispatcher, no fair-use cap.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LLMService,
    private readonly salonTools: SalonCopilotToolsService,
    private readonly approvals: ActionApprovalService,
    private readonly tiers: AssistantTierService,
  ) {}

  // ------------------------------------------------------------------
  //  Public API
  // ------------------------------------------------------------------

  /**
   * Find or create the conversation. Sprint 12: one persistent thread
   * per (user, tenant) — no session-id. Sprint 14+: support `sessionId`
   * to allow multiple ephemeral panels.
   *
   * P2A-staff-copilot-sprint16: when `sessionId` is provided, the
   * conversation is keyed on `(userId, tenantId, sessionId)`. When
   * null, the legacy "default thread" path is preserved (backwards
   * compatible with the existing one-persistent-thread UI).
   */
  async getOrCreateConversation(
    userId: string,
    tenantId: string,
    title?: string,
    sessionId?: string | null,
  ): Promise<AssistantConversationPublic> {
    const where: Record<string, unknown> = {
      userId,
      tenantId,
      sessionId: sessionId ?? null,
    };
    const existing = await this.prisma.assistantConversation.findFirst({
      where,
      orderBy: { updatedAt: 'desc' },
    });
    if (existing) return toPublicConversation(existing);

    const created = await this.prisma.assistantConversation.create({
      data: {
        tenantId,
        userId,
        title: title ?? null,
        sessionId: sessionId ?? null,
      },
    });
    return toPublicConversation(created);
  }

  /**
   * A new, empty thread for "Nueva conversación". getOrCreateConversation
   * returns the existing one, so the panel's clear button used to show the
   * old messages again on the next reply.
   */
  async startConversation(userId: string, tenantId: string): Promise<AssistantConversationPublic> {
    const created = await this.prisma.assistantConversation.create({
      data: { tenantId, userId, title: null, sessionId: null },
    });
    return toPublicConversation(created);
  }

  /**
   * The thread a message goes to: the one the panel names, which must be the
   * caller's own in their salon, else the persistent one.
   */
  private async resolveConversation(
    user: { id: string; tenantId: string },
    dto: Pick<SendAssistantMessageDto, 'conversationId' | 'sessionId'>,
  ): Promise<AssistantConversationPublic> {
    if (dto.conversationId) {
      const own = await this.prisma.assistantConversation.findFirst({
        where: { id: dto.conversationId, userId: user.id, tenantId: user.tenantId },
      });
      if (!own) throw new ForbiddenException('You do not own this conversation');
      return toPublicConversation(own);
    }
    return this.getOrCreateConversation(user.id, user.tenantId, undefined, dto.sessionId ?? null);
  }

  /**
   * Thumbs up/down on one of the copilot's replies (CopilotFeedback). Only
   * on an assistant message of the caller's own conversation; a second vote
   * on the same reply replaces the first.
   */
  async submitFeedback(
    user: { id: string; tenantId: string },
    input: { messageId: string; rating: 1 | -1; comment?: string | null },
  ): Promise<{ id: string; rating: number; createdAt: string }> {
    const message = await this.prisma.assistantMessage.findFirst({
      where: {
        id: input.messageId,
        role: 'assistant',
        conversation: { userId: user.id, tenantId: user.tenantId },
      },
      select: { id: true },
    });
    if (!message) throw new NotFoundException('Message not found');
    const comment = input.comment?.trim() ? input.comment.trim().slice(0, 500) : null;
    const existing = await this.prisma.copilotFeedback.findFirst({
      where: { messageId: message.id, userId: user.id },
      select: { id: true },
    });
    const row = existing
      ? await this.prisma.copilotFeedback.update({
          where: { id: existing.id },
          data: { rating: input.rating, comment },
        })
      : await this.prisma.copilotFeedback.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            messageId: message.id,
            rating: input.rating,
            comment,
          },
        });
    return { id: row.id, rating: row.rating, createdAt: row.createdAt.toISOString() };
  }

  async listConversations(userId: string, tenantId: string, sessionId?: string | null) {
    const where: Record<string, unknown> = {
      userId,
      tenantId,
      sessionId: sessionId ?? null,
    };
    const rows = await this.prisma.assistantConversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return rows.map(toPublicConversation);
  }

  async listMessages(conversationId: string, userId: string) {
    // P2A-copilot-permission: a user can only read their own conversation.
    const conv = await this.prisma.assistantConversation.findUnique({
      where: { id: conversationId },
      select: { userId: true },
    });
    if (!conv) return [];
    if (conv.userId !== userId) {
      throw new ForbiddenException('You do not own this conversation');
    }
    const rows = await this.prisma.assistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPublicMessage);
  }

  /**
   * Main entry point: take a user message, get the persistent
   * conversation, build the system prompt with the user's role +
   * today's briefing, call the LLM with the copilot toolset, persist
   * the assistant reply, return the full response.
   */
  async sendMessage(
    user: { id: string; tenantId: string; role: string },
    dto: SendAssistantMessageDto,
  ): Promise<AssistantSendResponse> {
    const start = Date.now();

    // P2A-staff-copilot-sprint15: cost-protection (RFC §15.7). If the
    // tenant has blown past 3× the Premium fee in the current month,
    // we short-circuit with an explanatory reply — never let the bill
    // run away.
    if (await this.tiers.isOverCostCap(user.tenantId)) {
      this.logger.warn(`Copilot cost cap reached for tenant=${user.tenantId}`);
      const conversation = await this.resolveConversation(user, dto);
      const reply =
        'Has alcanzado el límite de uso mensual del copiloto. Lo reactivamos automáticamente el día 1 del próximo mes. Si necesitas más capacidad antes, escríbenos a soporte.';
      const msg = await this.prisma.assistantMessage.create({
        data: { conversationId: conversation.id, role: 'assistant', content: reply },
      });
      await this.prisma.assistantConversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
      return {
        conversation: toPublicConversation(conversation),
        message: toPublicMessage(msg),
        pendingApprovals: [],
        toolsExecuted: [],
        costCapReached: true,
      } as AssistantSendResponse & { costCapReached: boolean };
    }

    // P2A-staff-copilot-sprint16: billing hook. One increment per
    // assistant turn (NOT per tool call — that would double-count
    // multi-tool turns). The cost-protection check above already
    // gated us, so the counter increment here is safe.
    await bumpUsageCounter(this.prisma, user.tenantId, 1);

    // 1. The conversation the panel is showing (conversationId), else the
    // persistent one (keyed by sessionId when the caller provided one —
    // see getOrCreateConversation).
    const conversation = await this.resolveConversation(user, dto);

    // 2. Load recent history (last 10 messages) for context. We filter
    // out messages whose role isn't valid for the LLM (Anthropic
    // rejects `approval` and `system` with 400 invalid_request_error):
    //  - `tool` → folded into the next assistant turn as user-side context
    //  - `approval` → translated to a user message so the model knows
    //    "the human saw the chip" without breaking the role enum.
    //  - `system` → never sent to the LLM (we have our own system prompt)
    const history = await this.prisma.assistantMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const historyForLlm = history.reverse().flatMap((m) => {
      if (m.role === 'assistant' || m.role === 'user') {
        return [{ role: m.role as 'user' | 'assistant', content: m.content }];
      }
      if (m.role === 'tool') {
        return [{ role: 'user' as const, content: m.content }];
      }
      if (m.role === 'approval') {
        // Surface the pending action as a user-side observation so the
        // LLM knows the user saw it. Only do this if the approval has
        // already been resolved (otherwise we'd be re-feeding the
        // PENDING card back to the LLM as if the user typed it).
        return [];
      }
      return [];
    });

    // 3. Persist the user message
    await this.prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: dto.content,
      },
    });

    // 4. Build context: salon's name + user's role + today's briefing
    const ctx = await this.buildPromptContext(user);

    // P2A-staff-copilot-sprint15: per-tenant tool filter. A Pro tenant
    // never sees write tools in the schema (so the LLM can't even try
    // to call them), a Premium tenant sees the full set. On top of the
    // tier check, the calling user's role narrows further: a manager
    // must NOT see create_coupon (owner-only per RFC §5), a staff
    // user must NOT see mark_no_show / create_coupon / close_waitlist_slot.
    const [tierRead, tierWrite] = await Promise.all([
      this.tiers.allowedReadTools(user.tenantId),
      this.tiers.allowedWriteTools(user.tenantId),
    ]);
    const roleWrite = new Set(this.writeToolsForRole(this.normaliseRole(user.role)));
    const allowedRead = tierRead;
    const allowedWriteSet = new Set(tierWrite.filter((t) => roleWrite.has(t)));
    const tierFilteredTools = (COPILOT_TOOLS as readonly any[]).filter((t) => {
      const name = (t as any).name as string;
      if (WRITE_TOOLS.has(name)) return allowedWriteSet.has(name);
      return allowedRead.includes(name);
    });

    // 5. Tool executor with sprint-14 gating: write tools produce a
    //    pending `ActionApproval` row instead of running. Read tools
    //    run synchronously as before.
    const pendingApprovals: Array<{
      id: string;
      toolName: string;
      preview: string;
      expiresAt: string;
    }> = [];

    const toolExecutor = async (name: string, input: unknown) => {
      // Defense-in-depth: even if the LLM hallucinates a write tool
      // name not in `tierFilteredTools`, refuse here instead of
      // letting it through.
      if (WRITE_TOOLS.has(name) && !allowedWriteSet.has(name)) {
        return {
          kind: 'tier_blocked',
          toolName: name,
          message: 'Tu plan actual no incluye acciones de escritura en el copiloto. Están en el plan Empresa.',
          upgradeUrl: '/dashboard/billing?source=copilot',
        };
      }
      if (WRITE_TOOLS.has(name)) {
        const preview = (TOOL_PREVIEW[name] ?? (() => `Acción pendiente: ${name}`))(input);
        // P2A-staff-copilot-sprint16: action-approval creation is
        // also billable (the tool re-runs at approve-time, which
        // costs another LLM call in the worst case). Increment
        // BEFORE the approval row exists so the counter never lies
        // about the work the copilot did.
        await bumpUsageCounter(this.prisma, user.tenantId, 1);
        const { id, expiresAt } = await this.approvals.createPending({
          tenantId: user.tenantId,
          userId: user.id,
          conversationId: conversation.id,
          toolName: name,
          toolInput: input,
          preview,
        });
        pendingApprovals.push({
          id,
          toolName: name,
          preview,
          expiresAt: expiresAt.toISOString(),
        });
        // Persist an AssistantMessage of role=approval so the panel
        // can render the chip inline. We do this here (not in a
        // batched call) so the message order matches the tool call.
        await this.prisma.assistantMessage.create({
          data: {
            conversationId: conversation.id,
            role: 'approval',
            content: preview,
            toolName: name,
            toolInput: input as any,
            pendingActionId: id,
          },
        });
        return {
          kind: 'pending_approval',
          approvalId: id,
          preview,
          expiresAt: expiresAt.toISOString(),
        };
      }
      return this.salonTools.execute(name, input, {
        prisma: this.prisma,
        tenantId: user.tenantId,
        userId: user.id,
        role: user.role as any,
      });
    };

    // 6. LLM call (the model picks the right tool, no intent dispatcher in
    //    sprint 12 — the system prompt instructs it directly).
    //
    // P2A-staff-copilot-sprint16: we MUST pass the copilot's own
    // system prompt here. Without the override, the LLMService
    // falls back to the customer-chatbot prompt, and the model
    // responds as if it were talking to a customer (`¡Hola! Soy
    // Kira, puedo ayudarte a reservar una cita…`) instead of an
    // internal staff assistant.
    const generation = await this.llmService.generateResponse(
      dto.content,
      historyForLlm,
      user.tenantId,
      undefined,  // no fallback provider
      {
        tools: tierFilteredTools as any,
        executeTool: toolExecutor as any,
        maxToolIterations: 5,
        toolChoice: 'auto',
        systemPromptOverride: buildCopilotSystemPrompt(ctx),
      },
    );

    const reply = generation.text;
    const latencyMs = Date.now() - start;

    // 7. Persist the assistant message + the tools it ran
    const toolsExecuted = ((generation as any).toolsExecuted ?? []) as Array<{
      name: string;
      input?: unknown;
      result?: unknown;
    }>;
    const assistantMessage = await this.prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: reply,
        // We don't store every tool detail to keep the assistant_messages row small.
        // The full tool log lives in the application logs.
      },
    });

    // 8. Bump conversation.updatedAt so it floats to the top of the list
    await this.prisma.assistantConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    this.logger.log(
      `Assistant reply user=${user.id} tools=${toolsExecuted.length} latency=${latencyMs}ms`,
    );

    return {
      conversation: toPublicConversation(conversation),
      message: toPublicMessage(assistantMessage),
      pendingApprovals,
      toolsExecuted: toolsExecuted.map((t) => ({
        name: t.name,
        input: t.input,
        result: t.result,
      })),
    };
  }

  // ------------------------------------------------------------------
  //  Internals
  // ------------------------------------------------------------------

  /**
   * Build the prompt context for the calling user:
   * - salon name (for tone)
   * - role-specific hint (read-only vs read+write)
   * - today's one-line briefing (so the LLM can answer "what's
   *   up today?" without a separate tool call)
   */
  private async buildPromptContext(user: {
    id: string;
    tenantId: string;
    role: string;
  }): Promise<CopilotPromptContext> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { name: true },
    });
    const userRow = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { firstName: true },
    });

    const role = this.normaliseRole(user.role);
    const briefing = await this.computeTodayBriefing(user.tenantId);

    return {
      salonName: tenant?.name ?? 'Kira Room',
      assistantName: 'Kira',
      role,
      professionalFirstName: userRow?.firstName,
      todayBriefingSummary: briefing,
      availableWriteTools: this.writeToolsForRole(role),
      language: 'es',
    };
  }

  /**
   * Per-role list of write tools. Mirrors RFC §5.
   *  - staff: draft + send (own clients only), reschedule (own)
   *  - receptionist / manager: all except create_coupon
   *  - owner / admin / saas_owner: all
   */
  private writeToolsForRole(role: CopilotPromptContext['role']): string[] {
    const all = [
      'draft_follow_up_message',
      'send_message',
      'reschedule_appointment',
      'mark_no_show',
      'create_coupon',
      'close_waitlist_slot',
    ];
    if (['owner', 'admin', 'saas_owner'].includes(role)) return all;
    if (['manager', 'receptionist'].includes(role)) {
      return all.filter((t) => t !== 'create_coupon');
    }
    if (role === 'staff') {
      return ['draft_follow_up_message', 'send_message', 'reschedule_appointment'];
    }
    return [];
  }

  // ------------------------------------------------------------------
  //  Daily briefing (P2A-copilot-sprint13)
  // ------------------------------------------------------------------

  /**
   * Structured "good morning" briefing returned by GET /assistant/insights/daily
   * and consumed by the briefing card on the panel. The shape is role-aware:
   *  - `staff` sees only their own agenda + their own clients at risk.
   *  - owner/manager/receptionist see the whole salon's view.
   *  - financial fields are gated to owner/manager/saas_owner.
   *
   * Sprint 14 will append `pendingActionsCount` from ActionApprovalService.
   */
  async getDailyBriefing(user: {
    id: string;
    tenantId: string;
    role: string;
  }): Promise<DailyBriefingPublic> {
    const role = this.normaliseRole(user.role);
    // "Today" is the salon's day, not the server's (UTC): between midnight
    // and 01:00/02:00 in Madrid the briefing used to be yesterday's.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { timezone: true, openingHours: true },
    });
    const timeZone = safeTimeZone(tenant?.timezone);
    const todayDay = salonToday(timeZone);
    const today = new Date(`${todayDay}T00:00:00.000Z`);
    const tomorrow = new Date(`${addDays(todayDay, 1)}T00:00:00.000Z`);

    // 1. Today's appointments — staff sees only their own.
    const apptWhere: Record<string, unknown> = {
      tenantId: user.tenantId,
      // The wizard's test booking is not part of the day (D27).
      isTest: false,
      scheduledDate: { gte: today, lt: tomorrow },
      status: { in: ['confirmed', 'pending', 'in_progress'] },
    };
    let staffProfessionalId: string | null = null;
    if (role === 'staff') {
      const prof = await this.prisma.professional.findFirst({
        where: { tenantId: user.tenantId, user: { id: user.id } },
        select: { id: true },
      });
      staffProfessionalId = prof?.id ?? '__no_match__';
      apptWhere.professionalId = staffProfessionalId;
    }

    const appts = await this.prisma.appointment.findMany({
      where: apptWhere,
      orderBy: { scheduledTime: 'asc' },
      select: {
        id: true,
        scheduledTime: true,
        status: true,
        professionalId: true,
        client: { select: { firstName: true } },
        professional: { select: { firstName: true } },
        duration: true,
        service: { select: { bufferTime: true } },
        services: {
          select: { type: true, status: true, service: { select: { bufferTime: true } } },
          orderBy: VISIT_ROW_ORDER as any,
        },
      },
    });

    // 2. Pending confirmations — only surfaced to roles that book/manage.
    const pendingConfirmations = appts
      .filter((a) => a.status === 'pending')
      .map((a) => ({
        id: a.id,
        time: a.scheduledTime,
        clientFirstName: a.client?.firstName ?? null,
        professionalFirstName: a.professional?.firstName ?? null,
      }));

    // 3. Gaps ≥ 30 min per professional, inside their bookable hours and
    // from now on (briefing-gaps.ts). A professional is free again after the
    // appointment (30 min when it has no length) and its cleanup time.
    const professionals = await this.prisma.professional.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        ...(staffProfessionalId ? { id: staffProfessionalId } : {}),
      },
      select: { id: true, firstName: true, workingHours: true },
    });
    const blocks = await timeOffBetween(this.prisma as any, user.tenantId, todayDay);
    const gaps = briefingGaps({
      day: todayDay,
      nowMinutes: salonNowMinutes(timeZone),
      openingHours: tenant?.openingHours,
      professionals,
      busy: appts.map((a) => ({
        professionalId: a.professionalId,
        start: a.scheduledTime,
        minutes: minutesUntilFree(a as any, 30),
      })),
      blocks,
    });

    // 4. Low stock — manager/owner/receptionist only.
    let lowStockCount = 0;
    let lowStockSample: Array<{ id: string; name: string; quantity: number; lowStockAlert: number }> = [];
    if (['owner', 'admin', 'manager', 'receptionist', 'saas_owner'].includes(role)) {
      const products = await this.prisma.product.findMany({
        where: {
          tenantId: user.tenantId,
          isActive: true,
          trackInventory: true,
        },
        orderBy: { quantity: 'asc' },
        take: 50,
        select: { id: true, name: true, quantity: true, lowStockAlert: true },
      });
      lowStockSample = products
        .filter((p) => p.quantity <= p.lowStockAlert)
        .slice(0, 5)
        .map((p) => ({
          id: p.id,
          name: p.name,
          quantity: p.quantity,
          lowStockAlert: p.lowStockAlert,
        }));
      lowStockCount = lowStockSample.length;
    }

    // 5. At-risk clients — clients whose last completed visit is ≥ 60d
    // ago, capped at 5. One who never came is not at risk of being lost.
    let clientsAtRiskCount = 0;
    let clientsAtRisk: Array<{ id: string; firstName: string; daysSinceLastVisit: number | null }> = [];
    if (['owner', 'admin', 'manager', 'receptionist', 'staff', 'saas_owner'].includes(role)) {
      const cutoff = new Date(today);
      cutoff.setUTCDate(cutoff.getUTCDate() - 60);
      const stale = await this.prisma.client.findMany({
        where: {
          tenantId: user.tenantId,
          status: 'active',
          isTest: false,
          lastVisit: { lt: cutoff },
          // Staff: only their own clients, as in Clientas. It was the whole
          // salon's list.
          ...(staffProfessionalId ? clientScopeWhere({ professionalId: staffProfessionalId }) : {}),
        },
        orderBy: { lastVisit: 'asc' },
        take: 5,
        select: { id: true, firstName: true, lastVisit: true, createdAt: true },
      });
      clientsAtRisk = stale.map((c) => {
        const ref = c.lastVisit ?? c.createdAt;
        const days = ref
          ? Math.floor((today.getTime() - ref.getTime()) / 86_400_000)
          : null;
        return {
          id: c.id,
          firstName: c.firstName,
          daysSinceLastVisit: days,
        };
      });
      clientsAtRiskCount = stale.length;
    }

    return {
      date: todayDay,
      role,
      appointments: {
        total: appts.length,
        confirmed: appts.filter((a) => a.status === 'confirmed').length,
        pending: appts.filter((a) => a.status === 'pending').length,
        items: appts.map((a) => ({
          id: a.id,
          time: a.scheduledTime,
          status: a.status,
          clientFirstName: a.client?.firstName ?? null,
          professionalFirstName: a.professional?.firstName ?? null,
        })),
      },
      pendingConfirmations: {
        total: pendingConfirmations.length,
        items: pendingConfirmations,
      },
      gaps: {
        total: gaps.length,
        items: gaps,
      },
      lowStock: {
        total: lowStockCount,
        items: lowStockSample,
      },
      clientsAtRisk: {
        total: clientsAtRiskCount,
        items: clientsAtRisk,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private normaliseRole(rawRole: string): CopilotPromptContext['role'] {
    const r = (rawRole || '').toLowerCase();
    if (r === 'saas_owner' || r === 'saas-owner') return 'saas_owner';
    if (r === 'owner' || r === 'admin' || r === 'manager' || r === 'staff' || r === 'receptionist') {
      return r;
    }
    return 'staff';
  }

  /**
   * One-line summary of today's appointments + gaps + unconfirmed.
   * The LLM uses this to start a fresh conversation with a useful
   * opening instead of a generic "Hola, ¿en qué puedo ayudarte?".
   */
  private async computeTodayBriefing(tenantId: string): Promise<string | undefined> {
    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const todayDay = salonToday(safeTimeZone(tenant?.timezone));
      const today = new Date(`${todayDay}T00:00:00.000Z`);
      const tomorrow = new Date(`${addDays(todayDay, 1)}T00:00:00.000Z`);

      const appts = await this.prisma.appointment.findMany({
        where: {
          tenantId,
          isTest: false,
          scheduledDate: { gte: today, lt: tomorrow },
          status: { in: ['confirmed', 'pending'] },
        },
        select: { scheduledTime: true, status: true, professionalId: true },
      });
      if (appts.length === 0) return undefined;

      const confirmed = appts.filter((a) => a.status === 'confirmed').length;
      const pending = appts.filter((a) => a.status === 'pending').length;
      return `Hoy ${confirmed} citas confirmadas y ${pending} pendientes de confirmar.`;
    } catch (err) {
      this.logger.warn(`Briefing fetch failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}

// ----------------------------------------------------------------------
//  mappers
// ----------------------------------------------------------------------

function toPublicConversation(
  c:
    | {
        id: string;
        tenantId: string;
        userId: string;
        sessionId: string | null;
        title: string | null;
        createdAt: Date;
        updatedAt: Date;
      }
    | AssistantConversationPublic,
): AssistantConversationPublic {
  return {
    id: c.id,
    tenantId: c.tenantId,
    userId: c.userId,
    sessionId: c.sessionId,
    title: c.title,
    createdAt:
      c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
    updatedAt:
      c.updatedAt instanceof Date ? c.updatedAt.toISOString() : c.updatedAt,
  };
}

function toPublicMessage(
  m: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    toolName: string | null;
    toolInput: unknown;
    toolResult: unknown;
    pendingActionId: string | null;
    createdAt: Date;
  },
): AssistantMessagePublic {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role as AssistantMessagePublic['role'],
    content: m.content,
    toolName: m.toolName,
    toolInput: m.toolInput,
    toolResult: m.toolResult,
    pendingActionId: m.pendingActionId,
    createdAt: m.createdAt.toISOString(),
  };
}

// ----------------------------------------------------------------------
//  Daily briefing types
// ----------------------------------------------------------------------

/**
 * Public shape returned by GET /assistant/insights/daily.
 * The same shape is used to render the BriefingCard on the panel.
 * `pendingActions` is appended by sprint 14 (ActionApprovalService).
 */
export interface DailyBriefingPublic {
  date: string;
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'receptionist' | 'saas_owner';
  appointments: {
    total: number;
    confirmed: number;
    pending: number;
    items: Array<{
      id: string;
      time: string;
      status: string;
      clientFirstName: string | null;
      professionalFirstName: string | null;
    }>;
  };
  pendingConfirmations: {
    total: number;
    items: Array<{
      id: string;
      time: string;
      clientFirstName: string | null;
      professionalFirstName: string | null;
    }>;
  };
  gaps: {
    total: number;
    items: Array<{
      start: string;
      end: string;
      minutes: number;
      professionalId: string;
      professionalFirstName: string;
    }>;
  };
  lowStock: {
    total: number;
    items: Array<{ id: string; name: string; quantity: number; lowStockAlert: number }>;
  };
  clientsAtRisk: {
    total: number;
    items: Array<{ id: string; firstName: string; daysSinceLastVisit: number | null }>;
  };
  generatedAt: string;
}
