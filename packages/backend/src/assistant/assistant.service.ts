import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { LLMService } from '../virtual-receptionist/services/llm.service';
import type { TokenCounts } from '../virtual-receptionist/providers/anthropic-models';
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
 * The Copilot's usage is counted on its own (copilot_usage_days, through
 * AssistantTierService.claimQuestion / recordCost). It used to add to
 * Tenant.aiConversationsUsed, the counter that cuts the clients' virtual
 * receptionist off at the plan's cap (Copilot audit M2, decision D3).
 */

/** The longest a Copilot turn may take, tool calls included (Copilot audit B6). */
export const COPILOT_TURN_TIMEOUT_MS = 60_000;

/** Questions one person may ask per minute (Copilot audit B5). */
export const COPILOT_QUESTIONS_PER_MINUTE = 20;

class CopilotTimeoutError extends Error {
  constructor() {
    super('copilot_turn_timeout');
  }
}

/**
 * Tools that ALWAYS require human approval before running. The
 * orchestrator detects these names and produces a pending_action
 * envelope instead of executing the tool synchronously.
 */
const WRITE_TOOLS = new Set<string>([
  'send_message',
  'reschedule_appointment',
  'mark_no_show',
  'create_coupon',
  'close_waitlist_slot',
]);

// The approval card's text is built from the database by
// SalonCopilotToolsService.approvalPreview, never from the model's words
// (Copilot audit A1).

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
      // The history dropdown showed only dates: a conversation from before
      // titles were set is named after its first question.
      include: {
        messages: { where: { role: 'user' }, orderBy: { createdAt: 'asc' }, take: 1, select: { content: true } },
      },
    });
    return rows.map(({ messages, ...c }) =>
      toPublicConversation({ ...c, title: c.title ?? (messages[0] ? conversationTitle(messages[0].content) : null) }),
    );
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
      // M9: the card shows what really happened to the action after a
      // reload (it guessed from the message's age: everything "caducada").
      include: { pendingAction: { select: { status: true, expiresAt: true, resultSnapshot: true } } },
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

    // Per person, not per address (Copilot audit B5): the route's
    // @Throttle counts by IP, and a whole salon behind one router shared it.
    if (!this.withinUserRate(user.id)) {
      return this.replyWithoutModel(
        user,
        dto,
        'Vas muy rápido: espera un minuto antes de la siguiente pregunta.',
        false,
      );
    }

    // The Copilot's own counter (Copilot audit M2/M3, D3/D4): questions per
    // day (fewer in the free trial) and the month's real model cost. It
    // used to add to Tenant.aiConversationsUsed, the counter that cuts the
    // clients' virtual receptionist off, and to cap an estimate of messages.
    const limit = await this.tiers.claimQuestion(user.tenantId);
    if (limit.ok === false && "reason" in limit) {
      this.logger.warn(`Copilot ${limit.reason} cap reached for tenant=${user.tenantId}`);
      return this.replyWithoutModel(user, dto, limit.message, true);
    }

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
      include: { pendingAction: { select: { status: true, resultSnapshot: true } } },
    });
    const historyForLlm = copilotHistoryForLlm(history.reverse());

    // 3. Persist the user message
    await this.prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: dto.content,
      },
    });
    // The first question names the conversation in the history dropdown.
    if (!conversation.title) {
      const title = conversationTitle(dto.content);
      await this.prisma.assistantConversation.updateMany({
        where: { id: conversation.id, title: null },
        data: { title },
      });
      conversation.title = title;
    }

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

    // 4. Build context: salon's name + user's role + today's briefing. The
    // actions the prompt lists are the ones this plan AND role allow: a Pro
    // salon was told it had all six, and the model offered them.
    const ctx = await this.buildPromptContext(user, [...allowedWriteSet]);
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

    // Set once the turn has been answered with the timeout message: a model
    // call still running must not add approval cards nobody will see.
    let abandoned = false;

    const toolExecutor = async (name: string, input: unknown) => {
      if (abandoned) return { error: 'turn_abandoned' };
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
        const preview = await this.salonTools.approvalPreview(name, input, {
          prisma: this.prisma,
          tenantId: user.tenantId,
          userId: user.id,
          role: user.role as any,
        });
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
    //
    // Today's briefing goes as the turn's server notes, after the cached
    // system prompt (Copilot audit B10): inside the prompt, every new
    // booking changed it and the cache was never hit.
    const briefing = ctx.todayBriefingSummary;
    const promptCtx = { ...ctx, todayBriefingSummary: undefined };
    let generation: Awaited<ReturnType<LLMService['generateResponse']>>;
    let timer: NodeJS.Timeout | undefined;
    try {
      generation = await Promise.race([
        this.llmService.generateResponse(
          dto.content,
          historyForLlm,
          user.tenantId,
          undefined,  // no fallback provider
          {
            tools: tierFilteredTools as any,
            executeTool: toolExecutor as any,
            maxToolIterations: 5,
            toolChoice: 'auto',
            systemPromptOverride: buildCopilotSystemPrompt(promptCtx),
            ...(briefing ? { systemNotes: `Resumen de hoy: ${briefing}` } : {}),
          },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CopilotTimeoutError()), COPILOT_TURN_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // The model failed or took too long (Copilot audit B6): an honest
      // reply in the thread, the question given back, and what the failed
      // call had already spent still counted. It used to be a generic
      // error, the question left unanswered and counted.
      abandoned = true;
      const timedOut = err instanceof CopilotTimeoutError;
      this.logger.error(
        `Copilot turn failed for tenant=${user.tenantId}: ${timedOut ? 'timeout' : (err as Error)?.message ?? err}`,
      );
      const spent = err as { usage?: TokenCounts; model?: string };
      if (spent?.usage) await this.tiers.recordCost(user.tenantId, spent.model, spent.usage);
      await this.tiers.releaseQuestion(user.tenantId);
      const msg = await this.prisma.assistantMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'assistant',
          content: timedOut
            ? 'He tardado demasiado en responder y lo he dejado. Prueba otra vez o haz una pregunta más concreta.'
            : 'Ahora mismo no puedo responder: el servicio de IA ha fallado. Prueba otra vez en un momento.',
        },
      });
      await this.prisma.assistantConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      return {
        conversation: toPublicConversation(conversation),
        message: toPublicMessage(msg),
        pendingApprovals,
        toolsExecuted: [],
      };
    } finally {
      if (timer) clearTimeout(timer);
    }

    // What the turn cost, in money, on the Copilot's own counter.
    await this.tiers.recordCost(user.tenantId, generation.model, generation.usage as TokenCounts | undefined);

    // B14: a refusal by the model came back with the receptionist's line
    // ("no puedo responder a eso por aquí"), written for clients.
    const reply =
      (generation as { finishReason?: string }).finishReason === 'refusal' ? COPILOT_REFUSAL_REPLY : generation.text;
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

  /** When each person's recent questions were asked (one API instance: memory is enough). */
  private readonly recentQuestions = new Map<string, number[]>();

  /** True while this person has asked fewer than COPILOT_QUESTIONS_PER_MINUTE in the last minute. */
  private withinUserRate(userId: string, now = Date.now()): boolean {
    const recent = (this.recentQuestions.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= COPILOT_QUESTIONS_PER_MINUTE) {
      this.recentQuestions.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.recentQuestions.set(userId, recent);
    if (this.recentQuestions.size > 5_000) {
      for (const [id, times] of this.recentQuestions) {
        if (times.every((t) => now - t >= 60_000)) this.recentQuestions.delete(id);
      }
    }
    return true;
  }

  /** A reply that never reached the model (a limit): kept in the thread so the panel shows it. */
  private async replyWithoutModel(
    user: { id: string; tenantId: string },
    dto: SendAssistantMessageDto,
    reply: string,
    costCapReached: boolean,
  ): Promise<AssistantSendResponse> {
    const conversation = await this.resolveConversation(user, dto);
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
      ...(costCapReached ? { costCapReached: true } : {}),
    } as AssistantSendResponse & { costCapReached?: boolean };
  }

  /**
   * Build the prompt context for the calling user:
   * - salon name (for tone)
   * - role-specific hint (read-only vs read+write)
   * - today's one-line briefing (so the LLM can answer "what's
   *   up today?" without a separate tool call)
   */
  private async buildPromptContext(
    user: {
      id: string;
      tenantId: string;
      role: string;
    },
    availableWriteTools: string[],
  ): Promise<CopilotPromptContext> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { name: true },
    });
    const userRow = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { firstName: true },
    });

    const role = this.normaliseRole(user.role);
    const briefing = await this.computeTodayBriefing(user.tenantId, role === 'staff' ? user.id : null);

    // Same order as the role list, so the prompt reads the same each time.
    const allowed = new Set(availableWriteTools);
    return {
      salonName: tenant?.name ?? 'Kira Room',
      assistantName: 'Kira',
      role,
      professionalFirstName: userRow?.firstName,
      todayBriefingSummary: briefing,
      availableWriteTools: this.writeToolsForRole(role).filter((t) => allowed.has(t)),
      language: 'es',
    };
  }

  /**
   * Per-role list of write tools. Mirrors RFC §5.
   *  - staff: send (own clients only), reschedule (own); drafting is a
   *    read tool (Copilot audit M8)
   *  - receptionist / manager: all except create_coupon
   *  - owner / admin / saas_owner: all
   */
  private writeToolsForRole(role: CopilotPromptContext['role']): string[] {
    const all = [
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
      return ['send_message', 'reschedule_appointment'];
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
      // B9: the count is every low product (of the 50 lowest), the sample
      // five; both were five, so the card's "+N" never showed.
      const low = products.filter((p) => p.quantity <= p.lowStockAlert);
      lowStockCount = low.length;
      lowStockSample = low
        .slice(0, 5)
        .map((p) => ({
          id: p.id,
          name: p.name,
          quantity: p.quantity,
          lowStockAlert: p.lowStockAlert,
        }));
    }

    // 5. At-risk clients — clients whose last completed visit is ≥ 60d
    // ago: the five longest gone, and how many there are in all (B9).
    // One who never came is not at risk of being lost.
    let clientsAtRiskCount = 0;
    let clientsAtRisk: Array<{ id: string; firstName: string; daysSinceLastVisit: number | null }> = [];
    if (['owner', 'admin', 'manager', 'receptionist', 'staff', 'saas_owner'].includes(role)) {
      const cutoff = new Date(today);
      cutoff.setUTCDate(cutoff.getUTCDate() - 60);
      const staleWhere: Prisma.ClientWhereInput = {
        tenantId: user.tenantId,
        status: 'active',
        isTest: false,
        lastVisit: { lt: cutoff },
        // Staff: only their own clients, as in Clientas. It was the whole
        // salon's list.
        ...(staffProfessionalId ? clientScopeWhere({ professionalId: staffProfessionalId }) : {}),
      };
      const [stale, staleCount] = await Promise.all([
        this.prisma.client.findMany({
          where: staleWhere,
          orderBy: { lastVisit: 'asc' },
          take: 5,
          select: { id: true, firstName: true, lastVisit: true, createdAt: true },
        }),
        this.prisma.client.count({ where: staleWhere }),
      ]);
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
      clientsAtRiskCount = staleCount;
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
  private async computeTodayBriefing(tenantId: string, staffUserId: string | null = null): Promise<string | undefined> {
    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const todayDay = salonToday(safeTimeZone(tenant?.timezone));
      const today = new Date(`${todayDay}T00:00:00.000Z`);
      const tomorrow = new Date(`${addDays(todayDay, 1)}T00:00:00.000Z`);

      // A professional's own day, not the whole salon's (as her briefing
      // card): the salon's totals used to reach the model for staff too.
      let professionalId: string | undefined;
      if (staffUserId) {
        const prof = await this.prisma.professional.findFirst({
          where: { tenantId, user: { id: staffUserId } },
          select: { id: true },
        });
        if (!prof) return undefined;
        professionalId = prof.id;
      }

      const appts = await this.prisma.appointment.findMany({
        where: {
          tenantId,
          isTest: false,
          scheduledDate: { gte: today, lt: tomorrow },
          status: { in: ['confirmed', 'pending'] },
          ...(professionalId ? { professionalId } : {}),
        },
        select: { scheduledTime: true, status: true, professionalId: true },
      });
      if (appts.length === 0) return undefined;

      const confirmed = appts.filter((a) => a.status === 'confirmed').length;
      const pending = appts.filter((a) => a.status === 'pending').length;
      return professionalId
        ? `Hoy tienes ${confirmed} citas confirmadas y ${pending} pendientes de confirmar.`
        : `Hoy ${confirmed} citas confirmadas y ${pending} pendientes de confirmar.`;
    } catch (err) {
      this.logger.warn(`Briefing fetch failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}

// ----------------------------------------------------------------------
//  mappers
// ----------------------------------------------------------------------

/** A conversation's name in the history: its first question, on one line, at most 60 characters. */
export function conversationTitle(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line || 'Conversación';
  const cut = line.slice(0, 59);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

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
    pendingAction?: { status: string; expiresAt: Date; resultSnapshot: unknown } | null;
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
    approval: m.pendingAction
      ? {
          status: m.pendingAction.status as NonNullable<AssistantMessagePublic['approval']>['status'],
          expiresAt: m.pendingAction.expiresAt.toISOString(),
          result: m.pendingAction.resultSnapshot ?? null,
        }
      : null,
  };
}

/** What the Copilot says when the model declines a request (B14). */
export const COPILOT_REFUSAL_REPLY =
  'No puedo ayudarte con esa petición. Si es algo del salón, prueba a preguntarlo de otra forma.';

/**
 * A resolved action, told to the model on the next turn: what it was, what
 * became of it and, in a few words, the result (the coupon code, the
 * tool's own message). Null while it is pending.
 */
/**
 * The stored messages as the model reads them. A resolved action card is
 * told as an observation (Copilot audit M8/M9) AFTER the reply of the turn
 * that proposed it: the card row is written during that turn, before the
 * reply, but it is approved or cancelled later. Told in place, the model read
 * "aprobada y hecha (código JX8SJN)" before its own "está pendiente de tu
 * aprobación", and then insisted the coupon had not been created. A pending
 * card says nothing (it would read as if the user had typed it).
 */
export function copilotHistoryForLlm(
  messages: Array<{ role: string; content: string; pendingAction?: { status?: string; resultSnapshot?: unknown } | null }>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let held: string[] = [];
  const flush = () => {
    for (const o of held) out.push({ role: 'user', content: o });
    held = [];
  };
  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content });
      flush();
    } else if (m.role === 'user') {
      // A card never answered by a reply (the turn failed): told before the next question.
      flush();
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'approval') {
      const observation = approvalObservation(m.content, m.pendingAction?.status, m.pendingAction?.resultSnapshot);
      if (observation) held.push(observation);
    }
  }
  flush();
  return out;
}

export function approvalObservation(preview: string, status: string | undefined, result: unknown): string | null {
  if (!status || status === 'pending') return null;
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  let outcome: string;
  if (status === 'executed' || status === 'approved') {
    outcome = r.error ? `aprobada, pero falló (${String(r.message ?? r.error)})` : 'aprobada y hecha';
  } else if (status === 'rejected') {
    outcome =
      r.error === 'forbidden'
        ? 'no se hizo: la usuaria no tiene permiso'
        : r.error
          ? `no se hizo (${String(r.message ?? r.error)})`
          : 'cancelada por la usuaria';
  } else {
    outcome = 'caducada sin respuesta (no se hizo)';
  }
  const details = [
    typeof r.code === 'string' ? `código ${r.code}` : null,
    typeof r.message === 'string' && !r.error ? r.message : null,
  ]
    .filter(Boolean)
    .join('. ');
  const text = `[Acción propuesta: «${preview}». Estado: ${outcome}${details ? `. ${details}` : ''}.]`;
  return text.length > 600 ? text.slice(0, 597) + '…]' : text;
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
