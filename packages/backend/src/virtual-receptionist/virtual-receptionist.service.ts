import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { LLMService } from './services/llm.service';
import { ConversationService } from './services/conversation.service';
import { FAQService } from './services/faq.service';
import { BookingService } from './services/booking.service';
import { claimsBooking, looksLikeSummary } from './tools/booking-claims';
import { recentHistory } from './recent-history';
import { isAffirmative } from './tools/receptionist-booking';
import { AnalysisService } from './services/analysis.service';
import { ProfessionalsService } from '../professionals/professionals.service';
import { SendMessageDto, MessageResponseDto, CreateConversationDto } from '@kira/shared';
import { ChatMessage, ChatIntent, LLMProvider } from '@kira/shared';
import { FAQCacheService } from './services/faq-cache.service';
import { UpsellService } from '../upsell/upsell.service';
import { AiConversationCounterService, FairUseDecision } from './services/ai-conversation-counter.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { SubscriptionsService } from '../payments/services/subscriptions.service';
import { ChannelRegistry } from './channels/channel.registry';
import { SalonToolsService, SALON_TOOLS, executeSalonTool } from './tools/salon-tools';
import { AppointmentsService } from '../appointments/appointments.service';

@Injectable()
export class VirtualReceptionistService {
  private readonly logger = new Logger(VirtualReceptionistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LLMService,
    private readonly conversationService: ConversationService,
    private readonly faqService: FAQService,
    private readonly faqCacheService: FAQCacheService,
    private readonly upsellService: UpsellService,
    private readonly bookingService: BookingService,
    private readonly analysisService: AnalysisService,
    private readonly professionalsService: ProfessionalsService,
    private readonly configService: ConfigService,
    private readonly aiCounter: AiConversationCounterService,
    // P2A-receptionist-v2 H-4 -- multi-channel outbound dispatch.
    private readonly channelRegistry: ChannelRegistry,
    // P2A-receptionist-v2 -- exposed for the /ai-usage billing meter.
    private readonly featureFlags: FeatureFlagService,
    private readonly subscriptions: SubscriptionsService,
    private readonly salonTools: SalonToolsService,
    private readonly appointmentsService: AppointmentsService,
  ) {}

  /**
   * Process incoming message and generate response
   */
  async sendMessage(dto: SendMessageDto): Promise<MessageResponseDto> {
    const startTime = Date.now();
    
    try {
      this.logger.log(`Processing message from client ${dto.clientId} via ${dto.channel}`);

      // Get or create conversation
      let conversation = await this.conversationService.findOrCreateConversation(dto);

      // Analyze message intent and entities
      const analysis = await this.analysisService.analyzeMessage(dto.message);

      // Add user message to conversation
      await this.conversationService.addMessage(conversation.id, {
        role: 'user',
        content: dto.message,
        timestamp: new Date(),
      });

      // Handle different message intents. Every intent produces a
      // *prompt hint* for the LLM; the LLM is the only thing that
      // actually writes the final reply, and it must do so by calling
      // the salon tools (data-grounded, no hallucination).
      let responseContent: string;
      let requiresHandoff = false;

      switch (analysis.intent) {
        case ChatIntent.BOOK_APPOINTMENT:
          // No hint. This used to prepend the legacy in-memory BookingService
          // script ("¿Qué servicio te gustaría reservar?...", its own
          // summary and "¿Deseas confirmar tu cita?") to the client's
          // message, a second booking flow competing with the tools. The
          // model and propose_appointment / create_appointment own it now.
          responseContent = '';
          break;

        case ChatIntent.CANCEL_APPOINTMENT:
        case ChatIntent.RESCHEDULE_APPOINTMENT:
        case ChatIntent.CHECK_AVAILABILITY:
        case ChatIntent.CHECK_APPOINTMENT:
          // No hint. handleAppointmentManagement prepended scripted text to
          // the client's message as if it were fact: for cancel/reschedule,
          // an invented phone and email ("123-456-7890", "info@ejemplo.com");
          // for "my appointment", a lookup by the visitor id that failed and
          // injected "no podemos verificar tus citas", which the model
          // relayed as a technical problem in the middle of a booking. The
          // model answers from the prompt and the tools.
          responseContent = '';
          break;

        case ChatIntent.PRICE_QUERY:
        case ChatIntent.SERVICE_INFO:
        case ChatIntent.PROFESSIONAL_INFO:
          // The LLM has tools to look up services / professionals and
          // must use them. We just nudge it with a short prompt hint.
          responseContent = await this.handleInformationQuery(dto, analysis);
          break;

        case ChatIntent.HOURS_INFO:
        case ChatIntent.LOCATION_INFO:
        case ChatIntent.CONTACT_INFO:
          responseContent = await this.handleInformationQuery(dto, analysis);
          break;

        case ChatIntent.COMPLAINT:
        case ChatIntent.FEEDBACK:
          responseContent = await this.handleComplaintOrFeedback(dto, analysis);
          requiresHandoff = true;
          break;

        default:
          // Everything else (greetings, short service queries, gender
          // follow-ups, "Y masajes hacéis?", "Pies", etc.) flows into
          // the LLM, which will pick the right tool to ground its
          // answer in real database data.
          responseContent = await this.handleGeneralQuery(dto, analysis);
      }

      // No handoff by length. At 20 messages this marked the conversation
      // "handoff" -- which nobody picks up -- and the lookup only resumes
      // "active" ones, so the next message started over with no memory: in a
      // real chat the client gave their phone and got the opening greeting.
      // A booking easily runs past 20 messages. What the model sees is capped
      // below instead (recentHistory), which is what bounds the cost.

      // P2A-fairuse: evaluate the cap and short-circuit when the tenant
      // has exceeded their monthly AI quota (Esencial default 500). The
      // counter is incremented only when an LLM call follows; FAQ cache
      // hits do not consume quota (the cache fast-path lives in
      // tryAnswerFromFaqCache, called earlier in sendMessage).
      //
      // Reason semantics:
      //   - 'ok' / 'unlimited' -> counter touched, LLM runs.
      //   - 'cap_exceeded' with action='degrade' -> short-circuit, no LLM.
      //   - 'cap_exceeded' with 'notify' / 'allow' -> counter NOT touched
      //     and LLM runs anyway (saas_owner preference).
      const fairUse = await this.maybeIncrementConversation(dto.salonId);
      if (!fairUse.allowed) {
        const fallback = await this.fairUseFallback(dto, fairUse);
        const responseTime = Date.now() - startTime;
        this.logger.warn(
          `AI fair-use short-circuit client ${dto.clientId} reason=${fairUse.reason} used=${fairUse.used}/${fairUse.cap} action=${fairUse.fairUseAction}`,
        );
        return fallback;
      }

      // Generate response using LLM with the salon tools available.
      // The model is the only writer; it must use the tools to fetch
      // any real data (prices, services, availability, professionals)
      // so it cannot hallucinate.
      let bookedThisTurn = false;
      let proposedThisTurn = false;
      const runTool =(name: string, input: unknown) =>
        executeSalonTool(this.salonTools, name, input, {
          prisma: this.prisma,
          tenantId: dto.salonId,
          appointmentsService: this.appointmentsService,
          // Booking is tied to this conversation: the proposal is stored on
          // it, and the client's reply this turn is what confirms it.
          conversation: {
            id: conversation.id,
            clientId: (conversation as any).clientId ?? dto.clientId,
            lastUserMessage: dto.message,
            channel: (conversation as any).channel,
            externalUserId: (conversation as any).context?.externalUserId,
          },
        });
      const toolExecutor = async (name: string, input: unknown) => {
        const result = await runTool(name, input);
        // Which tool ran and how it ended -- without the payload, which may
        // carry the client's details.
        const r = result as Record<string, unknown>;
        // Field names and error messages say why a call failed without
        // exposing the client's details.
        const detail = Array.isArray(r?.fields)
          ? ` fields=${(r.fields as string[]).join(',')}`
          : r?.error && typeof r?.message === 'string'
            ? ` (${String(r.message).slice(0, 120)})`
            : '';
        // Which service, professional and day were asked about: ids and a
        // date, nothing about the client.
        const a = (input ?? {}) as Record<string, unknown>;
        const asked = ['serviceId', 'professionalId', 'date', 'time', 'keyword', 'audience', 'specialty', 'language']
          .filter((k) => typeof a[k] === 'string' && a[k])
          .map((k) => `${k}=${String(a[k]).slice(0, 40)}`)
          .join(' ');
        this.logger.log(
          `tool ${name}${asked ? ` [${asked}]` : ''} -> ${r?.error ? `error=${r.error}${detail}` : r?.created !== undefined ? `created=${r.created}` : r?.proposed !== undefined ? `proposed=${r.proposed}` : 'ok'}`,
        );
        if (name === 'create_appointment' && (result as any)?.created === true) {
          bookedThisTurn = true;
        }
        if (name === 'propose_appointment' && (result as any)?.proposed === true) {
          proposedThisTurn = true;
        }
        return result;
      };
// P2A-receptionist-tools: the LLM needs to actually see the
      // user's message — previously the orchestrator passed the
      // intent-handler's prompt hint (which is often empty for
      // catalog queries) and the user's actual text was only
      // stored in the conversation history, which the LLM only
      // sees when there is prior context. For first turns the LLM
      // was responding to "" with a generic greeting. Combine both
      // here so the model always sees what the user actually asked.
      // On WhatsApp the sender's number is their phone, and the booking tool
      // already uses it (channelPhone): the model must not ask for it again.
      const channelNote =
        String(dto.channel) === 'whatsapp' && dto.metadata?.clientPhone
          ? `[Nota del sistema: el cliente escribe por WhatsApp desde el ${dto.metadata.clientPhone}. Ese es su teléfono: no se lo pidas. Para reservar, pídele solo el nombre y los apellidos.]\n\n`
          : '';
      const userUtterance =
        channelNote +
        (responseContent ? `${responseContent}\n\nUsuario: ${dto.message}` : dto.message);

      // P2A-receptionist-tools: MiniMax-M3 partially honors
      // `tool_choice: { type: 'tool', name: '...' }` — but only for
      // tools WITHOUT required parameters (list_services,
// get_salon_info, list_professionals). For tools with required params
      // (check_availability needs serviceId + date) the LLM refuses
      // even when forced and falls back to "tell me the service
      // first". So we force only the param-free tools; availability
      // queries with all-required params fall through to `auto` and
      // rely on the strengthened system prompt + intent routing.
      const NO_PARAM_TOOLS = new Set([
        'list_services',
        'get_salon_info',
        'list_professionals',
      ]);
      const INTENT_TOOL: Partial<Record<ChatIntent, string>> = {
        [ChatIntent.PRICE_QUERY]: 'list_services',
        [ChatIntent.SERVICE_INFO]: 'list_services',
        [ChatIntent.PROFESSIONAL_INFO]: 'list_professionals',
        [ChatIntent.HOURS_INFO]: 'get_salon_info',
        [ChatIntent.LOCATION_INFO]: 'get_salon_info',
        [ChatIntent.CONTACT_INFO]: 'get_salon_info',
      };
      // A yes to a stored, unbooked proposal books it. create_appointment
      // takes no parameters, so it can be forced even on providers that
      // ignore forced tools with required ones; leaving it to the model let
      // it answer "confirmada" without calling anything.
      const pending = await this.pendingProposal(conversation.id);
      const forcedTool =
        pending && isAffirmative(dto.message) ? 'create_appointment' : INTENT_TOOL[analysis.intent];
      const toolChoice: 'auto' | { type: 'tool'; name: string } =
        forcedTool && (NO_PARAM_TOOLS.has(forcedTool) || forcedTool === 'create_appointment')
          ? { type: 'tool', name: forcedTool }
          : 'auto';

      const generate = (utterance: string, choice: typeof toolChoice) =>
        this.llmService.generateResponse(utterance, recentHistory(conversation.messages), dto.salonId, undefined, {
          tools: SALON_TOOLS,
          executeTool: toolExecutor,
          maxToolIterations: 5,
          toolChoice: choice,
        });
      let generationResult = await generate(userUtterance, toolChoice);

      // The reply must not announce a booking the tools did not make. One
      // retry with the facts spelled out; if the model still claims it, the
      // client gets a plain, true answer instead.
      //
      // A claim about the appointment this conversation already booked is
      // true: after booking, a second "sí" made the model repeat the
      // confirmation, and the fallback then told the client it was NOT
      // booked. It is let through only while every time it names is that
      // booking's, so "done, the waxing at 10:00 too" is still caught.
      const booked = await this.bookedProposal(conversation.id);
      const aboutBooked = (text: string) =>
        !!booked && (text.match(/\b\d{1,2}[:.]\d{2}\b/g) ?? []).every((t: string) => t.replace('.', ':').padStart(5, '0') === booked.time);
      const falseClaim = (text: string) => !bookedThisTurn && claimsBooking(text) && !aboutBooked(text);
      if (falseClaim(generationResult.text)) {
        this.logger.warn(
          `Receptionist claimed a booking without creating one (client ${dto.clientId}); regenerating`,
        );
        generationResult = await generate(
          `${userUtterance}\n\n[Nota del sistema: en este turno NO se ha creado ninguna cita. No digas que está confirmada ni reservada. Si el cliente quiere reservar, usa propose_appointment y, cuando diga que sí, create_appointment.]`,
          'auto',
        );
        if (falseClaim(generationResult.text)) {
          generationResult = {
            ...generationResult,
            text:
              'Todavía no he podido registrar tu cita, así que aún no está reservada. ' +
              '¿Me confirmas el servicio, el día y la hora para intentarlo de nuevo?',
          };
        }
      }

      // A summary the client can say yes to must be one propose_appointment
      // recorded -- that is what create_appointment books. A summary the
      // model wrote on its own left nothing to book on "sí", and the
      // proposal made afterwards could differ from what the client saw (it
      // named another professional). Regenerate once, requiring the tool.
      if (!bookedThisTurn && !proposedThisTurn && looksLikeSummary(generationResult.text)) {
        this.logger.warn(
          `Receptionist showed a summary without proposing it (client ${dto.clientId}); regenerating`,
        );
        const retried = await generate(
          `${userUtterance}\n\n[Nota del sistema: antes de mostrar el resumen llama a propose_appointment con los datos, y muestra exactamente el resumen que devuelva.]`,
          { type: 'tool', name: 'propose_appointment' },
        );
        // If the proposal still failed, the retry usually says why (the
        // slot is taken, a detail is missing). What must not reach the
        // client is a summary nothing recorded.
        if (proposedThisTurn || !looksLikeSummary(retried.text)) {
          generationResult = retried;
        } else {
          generationResult = {
            ...retried,
            text:
              'No he podido preparar la reserva con esos datos, así que todavía no está hecha. ' +
              '¿Me confirmas el servicio, el día y la hora que prefieres?',
          };
        }
      }

      // Add assistant message to conversation. The time it took is kept so
      // the panel's average response time is measured, not assumed.
      await this.conversationService.addMessage(conversation.id, {
        role: 'assistant',
        content: generationResult.text,
        timestamp: new Date(),
        provider: generationResult.provider,
        responseTime: Date.now() - startTime,
      });

      // Update conversation handoff status
      if (requiresHandoff) {
        await this.conversationService.updateConversation(conversation.id, {
          status: 'handoff',
        });
      }

      const responseTime = Date.now() - startTime;

      this.logger.log(`Generated response for client ${dto.clientId} in ${responseTime}ms`);

      // P2A-receptionist-v2 H-4: dispatch the reply through the
      // appropriate channel provider. For WhatsApp / Facebook /
      // Instagram / Telegram this sends the outbound message via the
      // Graph API / Bot API. For Web, the message is rendered by the
      // frontend from the same response body (no separate send).
      const outbound = await this.channelRegistry
        .send(dto.salonId, conversation.channel as any, {
          externalUserId:
            (conversation.context as any)?.externalUserId ?? '',
          text: generationResult.text,
          ctx: {
            tenantId: dto.salonId,
            conversationId: conversation.id,
            recipientName: (conversation.context as any)?.recipientName,
            metadata: { channel: conversation.channel },
          },
        })
        .catch((err) => {
          const e = err as Error;
          this.logger.warn(
            `Channel dispatch failed for ${dto.salonId}/${conversation.channel}: ${e.message}`,
          );
          return null;
        });

      return {
        id: conversation.id,
        content: generationResult.text,
        provider: outbound?.messageId
          ? LLMProvider.SYSTEM
          : (generationResult.provider ?? LLMProvider.SYSTEM),
        model: generationResult.model,
        responseTime,
        requiresHandoff,
        intent: analysis.intent,
        channelDispatched: !!outbound,
        // P2A-receptionist-tools: surface the tools the LLM actually
        // executed so the widget's debug bubble and the L-1 harness
        // can verify "did the model call the right tool?". The orchestrator
        // never uses this field itself; it's a passthrough.
        toolsExecuted: (generationResult as any).toolsExecuted,
      };

    } catch (error) {
      const err = error as Error;
      this.logger.error(`Error processing message from client ${dto.clientId}:`, err);

      // Return fallback message
      return {
        id: 'error-response',
        content: this.configService.get('VIRTUAL_RECEPTIONIST_FALLBACK_MESSAGE') ||
          'Lo sentimos, estamos experimentando problemas técnicos. Por favor, contáctanos directamente.',
        provider: LLMProvider.SYSTEM,
        model: 'fallback',
        responseTime: Date.now() - startTime,
        requiresHandoff: true,
        intent: ChatIntent.OTHER,
        // No error detail: this endpoint is public, and the widget showed
        // it to any visitor under "Debug:" -- the provider's own message,
        // e.g. "Your credit balance is too low". It is in the log above.
      };
    }
  }

  /** The conversation's proposal from propose_appointment, if not booked yet. */
  /** The conversation's latest proposal, if it has been booked. */
  private async bookedProposal(conversationId: string): Promise<{ time: string } | null> {
    const row = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { context: true },
    });
    const pending = (row?.context as any)?.pendingBooking;
    return pending?.bookedAppointmentId ? { time: String(pending.time) } : null;
  }

  private async pendingProposal(conversationId: string): Promise<boolean> {
    const row = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { context: true },
    });
    const pending = (row?.context as any)?.pendingBooking;
    return !!pending && !pending.bookedAppointmentId;
  }

  private async handleInformationQuery(dto: SendMessageDto, analysis: any): Promise<string> {
    this.logger.log(`Handling information query for client ${dto.clientId}`);

    // NOTE: the FAQ short-circuit used to live here (return
    // faqMatch.answer) but it hijacked every service / price / hours
    // query and fed the canned text to the LLM as the "user message",
    // causing the LLM to rephrase the FAQ as a generic greeting. The
    // LLM with tools is now responsible for grounding; the FAQ service
    // is still injected so it can be wired into the system prompt
    // later if a hybrid (FAQ + tools) answer is desired.
    void this.faqService; // keep the dependency reference for future wiring
    return '';
  }

  private async handleComplaintOrFeedback(dto: SendMessageDto, analysis: any): Promise<string> {
    this.logger.log(`Handling complaint/feedback for client ${dto.clientId}`);
    
    return 'Lo sentimos por la inconveniencia. Un miembro de nuestro equipo se pondrá en contacto contigo pronto.';
  }

  private async handleGeneralQuery(dto: SendMessageDto, analysis: any): Promise<string> {
    this.logger.log(`Handling general query for client ${dto.clientId}`);

    // Extract client information from metadata
    const clientName = dto.metadata?.clientName;

    // P2A-receptionist-advanced H-2: detect upsell intent BEFORE
    // the FAQ fallback so a "qué más ofrecen" question gets a real
    // recommendation instead of the generic "¿En qué puedo ayudarte
    // hoy?" placeholder. Requires the advanced feature; the service
    // short-circuits with an empty array for Esencial without
    // ai_expansion.
    const upsellKeywords = (analysis?.keywords ?? []).map((w: any) =>
      String(w).toLowerCase(),
    );
    const upsellTriggered = upsellKeywords.some((kw: string) =>
      ['recomienda', 'recomend', 'recomiénd', 'qué más', 'que más', 'sugieres', 'sugerir', 'tienen', 'ofrecen', 'servicios', 'productos', 'carta', 'lista', 'opciones'].some(
        (k) => kw.includes(k) || k.includes(kw),
      ),
    );
    if (upsellTriggered) {
      const suggestions = await this.upsellService.suggest(dto.salonId, {
        clientId: dto.clientId,
        excludeServiceIds: dto.metadata?.serviceId
          ? [dto.metadata.serviceId]
          : undefined,
      });
      if (suggestions.length > 0) {
        // No greeting: this is a hint in the middle of a conversation.
        const greeting = '';
        const list = suggestions
          .map(
            (s, i) =>
              `${i + 1}. ${s.serviceName} (${s.duration} min) — ${s.price.toFixed(2)}€`,
          )
          .join('\n');
        return (
          `${greeting}Claro, además del servicio que ya conoces te pueden interesar:\n${list}\n` +
          `Si quieres reservar uno solo dime cuál y te busco hueco.`
        );
      }
    }

    // NOTE: the FAQ short-circuit used to live here (return
    // faqMatch.answer), but it caused every service / price / hours
    // query to be answered with a canned FAQ string. The LLM with
    // tools is now responsible for grounding — the FAQ service is
    // still queried by `llm.service` so its knowledge can be used
    // as additional system-prompt context if desired.
    //
    // No hint either. This returned "¡Hola! ¿En qué puedo ayudarte hoy?",
    // which was prepended to every message without a more specific intent --
    // a phone number, "vale", a name -- so the model greeted the client again
    // in the middle of a booking.
    return '';
  }

  /**
   * P2A-receptionist-v2 -- read the effective IA cap for a tenant
   * (plan + addons). Returns null = unlimited. Used by the billing
   * dashboard's AI usage meter.
   */
  async resolveEffectiveCap(tenantId: string): Promise<number | null> {
    const ctx = await this.featureFlags.getContext(tenantId);
    if (!ctx) return null;
    const hasAiExpansion = ctx.addonsUnlocked.includes('virtual_receptionist_advanced' as any);
    return this.subscriptions.resolveEffectiveAiCap(ctx.plan, hasAiExpansion);
  }

  /** Current month's AI conversation count for the tenant. */
  async getCurrentAiCount(tenantId: string): Promise<number> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { aiConversationsUsed: true },
    });
    return t?.aiConversationsUsed ?? 0;
  }

  /** Next monthly reset timestamp for the AI cap. Null = no cap (unlimited). */
  async getAiResetAt(tenantId: string): Promise<string | null> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { aiConversationsResetAt: true },
    });
    return t?.aiConversationsResetAt?.toISOString() ?? null;
  }

  /**
   * Evaluate AI fair-use + increment the counter (when allowed).
   *
   * Returns the decision in both branches so the orchestrator can
   * decide whether to invoke the LLM:
   *
   *  - allowed=true  -> counter incremented, LLM call follows.
   *  - allowed=false -> counter NOT touched, orchestrator must
   *                     short-circuit (calls fairUseFallback).
   */
  private async maybeIncrementConversation(
    salonId: string,
  ): Promise<FairUseDecision> {
    const decision = await this.aiCounter.evaluate(salonId);
    if (decision.allowed) {
      try {
        await this.aiCounter.increment(salonId);
      } catch (err) {
        this.logger.warn(
          `AI counter increment failed (non-blocking): ${(err as Error).message}`,
        );
      }
    }
    return decision;
  }

  /**
   * Soft-degradation reply for tenants over the AI fair-use cap.
   * Persisted as an assistant turn so the conversation history
   * stays coherent. Always flagged requiresHandoff=true so the
   * inbox / dashboard surfaces the rollover.
   */
  private async fairUseFallback(
    dto: SendMessageDto,
    decision: FairUseDecision,
  ): Promise<MessageResponseDto> {
    const clientName = dto.metadata && dto.metadata.clientName;
    const greeting = clientName
      ? `Hola ${clientName.split(' ')[0]}, `
      : '';
    const text =
      greeting +
      'ahora mismo estoy en el limite mensual de conversaciones de IA de tu plan; te paso con un humano del salón para que te atienda sin demora.';
    const conversation = await this.conversationService.findOrCreateConversation(dto);
    await this.conversationService.addMessage(conversation.id, {
      role: 'assistant',
      content: text,
      timestamp: new Date(),
      provider: 'AI_FAIRUSE_FALLBACK' as any,
    });
    const analysis = await this.analysisService.analyzeMessage(dto.message);
    return {
      id: conversation.id,
      content: text,
      provider: 'AI_FAIRUSE_FALLBACK' as any,
      model: 'fair-use-fallback',
      responseTime: 0,
      requiresHandoff: true,
      intent: analysis.intent,
      limitInfo: {
        cap: decision.cap,
        used: decision.used,
        action: decision.fairUseAction,
      },
    };
  }
}
