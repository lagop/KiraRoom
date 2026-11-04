import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { LLMService } from './services/llm.service';
import { ConversationService } from './services/conversation.service';
import { BookingService } from './services/booking.service';
import { claimsBooking, looksLikeSummary } from './tools/booking-claims';
import { recentHistory } from './recent-history';
import { isAffirmative, isReplyToProposal, PendingBooking } from './tools/receptionist-booking';
import { AnalysisService } from './services/analysis.service';
import { ProfessionalsService } from '../professionals/professionals.service';
import { SendMessageDto, MessageResponseDto } from '@kira/shared';
import { ChatIntent, LLMProvider } from '@kira/shared';
import { UpsellService } from '../upsell/upsell.service';
import { AiConversationCounterService, FairUseDecision } from './services/ai-conversation-counter.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { SubscriptionsService } from '../payments/services/subscriptions.service';
import { ChannelRegistry } from './channels/channel.registry';
import { SalonToolsService, SALON_TOOLS, executeSalonTool } from './tools/salon-tools';
import { AppointmentsService } from '../appointments/appointments.service';
import { isReadOnlyStatus } from '../common/guards/read-only-tenant.guard';
import { logId } from './log-id';
import { AI_USAGE_SELECT, aiUsageThisMonth } from '../common/ai-usage/ai-monthly-usage';

/** What the fixed replies need to know about the salon. */
interface SalonContact {
  name: string;
  phone: string | null;
  language: 'es' | 'en';
  subscriptionStatus: string | null;
}

/**
 * Words a client uses to ask for suggestions. The cross-sell used to fire on
 * "tienen", "servicios", "opciones", "lista"... -- most messages -- and its
 * list was put in the client's own message as if she had written it.
 */
const SUGGESTION_REQUEST = /\b(recomiend\w*|recomend\w*|sugier\w*|sugerenci\w*|aconsej\w*|que mas (tienes|teneis|tienen|ofreces|ofreceis|ofrecen|hay|me (recomiendas|ofreces)))\b/;

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[¡!¿?.,;:()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function asksForSuggestions(message: string): boolean {
  return SUGGESTION_REQUEST.test(normalise(message));
}

@Injectable()
export class VirtualReceptionistService {
  private readonly logger = new Logger(VirtualReceptionistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LLMService,
    private readonly conversationService: ConversationService,
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
    // Never the id itself in the logs: on WhatsApp it is the sender's number.
    const who = logId(dto.clientId);
    let conversation: Awaited<ReturnType<ConversationService['findOrCreateConversation']>> | null = null;
    let salon: SalonContact | null = null;
    // What create_appointment returned this turn, when it booked.
    let booked: Record<string, unknown> | null = null;

    try {
      salon = await this.salonContact(dto.salonId);

      // A salon without an active plan (cancelled, suspended) is read-only:
      // no AI chat, which KiraRoom pays for, and no collecting a visitor's
      // details for a booking that would be refused at the end. The visitor
      // gets the salon's phone. (Other channels are already off for it:
      // they check the virtual_receptionist feature, which a read-only
      // salon does not have.)
      if (salon && isReadOnlyStatus(salon.subscriptionStatus)) {
        this.logger.log(`Salon ${dto.salonId} is read-only; chat not answered (${who})`);
        return {
          id: 'salon-unavailable',
          content: this.unavailableText(salon),
          provider: LLMProvider.SYSTEM,
          model: 'salon-unavailable',
          responseTime: Date.now() - startTime,
          requiresHandoff: false,
          intent: ChatIntent.OTHER,
        };
      }

      this.logger.log(`Processing message from ${who} via ${dto.channel}`);

      // Get or create conversation
      conversation = await this.conversationService.findOrCreateConversation(dto);
      const current = conversation;
      // The client's messages so far, this one included.
      const currentUserTurn = (current.messages ?? []).filter((m: { role?: string }) => m.role === 'user').length + 1;

      // Analyze message intent and entities
      const analysis = await this.analysisService.analyzeMessage(dto.message);

      // Add user message to conversation
      await this.conversationService.addMessage(current.id, {
        role: 'user',
        content: dto.message,
        timestamp: new Date(),
      });

      // Every intent may add a note for the model. The model is the only
      // thing that writes the final reply, and it must do so by calling the
      // salon tools (data-grounded, no hallucination).
      //
      // Notes go to the model as system text (LLMService systemNotes), never
      // glued to the client's message: there a client could write something
      // that looks just like one, and the model could not tell them apart.
      const notes: string[] = [];
      let requiresHandoff = false;

      switch (analysis.intent) {
        // No note for these. BOOK_APPOINTMENT used to prepend the legacy
        // in-memory BookingService script, a second booking flow competing
        // with the tools; the appointment-management ones prepended an
        // invented phone and email, or "no podemos verificar tus citas".
        case ChatIntent.BOOK_APPOINTMENT:
        case ChatIntent.CANCEL_APPOINTMENT:
        case ChatIntent.RESCHEDULE_APPOINTMENT:
        case ChatIntent.CHECK_AVAILABILITY:
        case ChatIntent.CHECK_APPOINTMENT:
        case ChatIntent.PRICE_QUERY:
        case ChatIntent.SERVICE_INFO:
        case ChatIntent.PROFESSIONAL_INFO:
        case ChatIntent.HOURS_INFO:
        case ChatIntent.LOCATION_INFO:
        case ChatIntent.CONTACT_INFO:
          break;

        case ChatIntent.COMPLAINT:
        case ChatIntent.FEEDBACK:
          notes.push(this.complaintNote(salon));
          requiresHandoff = true;
          break;

        default: {
          // Everything else (greetings, short service queries, "Y masajes
          // hacéis?", "Pies", etc.) flows into the LLM, which picks the right
          // tool to ground its answer in real database data.
          const suggestions = await this.suggestionsNote(dto);
          if (suggestions) notes.push(suggestions);
        }
      }

      // On WhatsApp the sender's number is their phone, and the booking tool
      // already uses it (channelPhone): the model must not ask for it again.
      if (String(dto.channel) === 'whatsapp' && dto.metadata?.clientPhone) {
        notes.push(
          `El cliente escribe por WhatsApp desde el ${dto.metadata.clientPhone}. Ese es su teléfono: no se lo pidas. ` +
            'Para reservar, pídele solo el nombre y los apellidos.',
        );
      }

      // No handoff by length. At 20 messages this marked the conversation
      // "handoff" -- which nobody picks up -- and the lookup only resumes
      // "active" ones, so the next message started over with no memory. What
      // the model sees is capped below instead (recentHistory).

      // P2A-fairuse: the tenant's monthly and daily AI caps. The message
      // counts only once the model has answered (countAiMessage below): it
      // used to count before the call, so a failed call still used up the
      // salon's allowance.
      //   - allowed            -> LLM runs, then the message is counted.
      //   - not allowed        -> short-circuit, no LLM.
      const fairUse = await this.aiCounter.evaluate(dto.salonId);
      if (!fairUse.allowed) {
        const fallback = await this.fairUseFallback(dto, fairUse, current, salon);
        this.logger.warn(
          `AI fair-use short-circuit ${who} reason=${fairUse.reason} used=${fairUse.used}/${fairUse.cap} action=${fairUse.fairUseAction}`,
        );
        return fallback;
      }

      // Generate response using LLM with the salon tools available.
      let bookedThisTurn = false;
      let proposedThisTurn = false;
      const runTool = (name: string, input: unknown) =>
        executeSalonTool(this.salonTools, name, input, {
          prisma: this.prisma,
          tenantId: dto.salonId,
          appointmentsService: this.appointmentsService,
          featureFlags: this.featureFlags,
          // Booking is tied to this conversation: the proposal is stored on
          // it, and the client's reply this turn is what confirms it.
          conversation: {
            id: current.id,
            clientId: (current as any).clientId ?? dto.clientId,
            lastUserMessage: dto.message,
            channel: (current as any).channel,
            externalUserId: (current as any).context?.externalUserId,
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
          booked = r;
        }
        if (name === 'propose_appointment' && (result as any)?.proposed === true) {
          proposedThisTurn = true;
        }
        return result;
      };

      // Only the param-free tools are forced (a forced tool with required
      // parameters makes the model invent them); availability queries fall
      // through to `auto`.
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
      // A yes to the summary just shown books it. create_appointment takes
      // no parameters, so it can be forced even on providers that ignore
      // forced tools with required ones; leaving it to the model let it
      // answer "confirmada" without calling anything. Only a reply to the
      // latest proposal counts (isReplyToProposal): a "sí" to a later
      // question booked the old summary.
      const pending = await this.pendingProposal(current.id);
      const forcedTool =
        pending && isReplyToProposal(pending, currentUserTurn) && isAffirmative(dto.message)
          ? 'create_appointment'
          : INTENT_TOOL[analysis.intent];
      const toolChoice: 'auto' | { type: 'tool'; name: string } =
        forcedTool && (NO_PARAM_TOOLS.has(forcedTool) || forcedTool === 'create_appointment')
          ? { type: 'tool', name: forcedTool }
          : 'auto';

      const generate = (extraNotes: string[], choice: typeof toolChoice) => {
        const all = [...notes, ...extraNotes];
        return this.llmService.generateResponse(dto.message, recentHistory(current.messages), dto.salonId, undefined, {
          tools: SALON_TOOLS,
          executeTool: toolExecutor,
          maxToolIterations: 5,
          toolChoice: choice,
          ...(all.length > 0 ? { systemNotes: all.map((n) => `- ${n}`).join('\n') } : {}),
        });
      };
      let generationResult = await generate([], toolChoice);
      // The model answered: now the message counts against the salon's cap.
      await this.countAiMessage(dto.salonId);

      // The reply must not announce a booking the tools did not make. One
      // retry with the facts spelled out; if the model still claims it, the
      // client gets a plain, true answer instead.
      //
      // A claim about the appointment this conversation already booked is
      // true: after booking, a second "sí" made the model repeat the
      // confirmation. It is let through only while every time it names is
      // that booking's, so "done, the waxing at 10:00 too" is still caught.
      const bookedBefore = await this.bookedProposal(current.id);
      const aboutBooked = (text: string) =>
        !!bookedBefore && (text.match(/\b\d{1,2}[:.]\d{2}\b/g) ?? []).every((t: string) => t.replace('.', ':').padStart(5, '0') === bookedBefore.time);
      const falseClaim = (text: string) => !bookedThisTurn && claimsBooking(text) && !aboutBooked(text);
      if (falseClaim(generationResult.text)) {
        this.logger.warn(`Receptionist claimed a booking without creating one (${who}); regenerating`);
        generationResult = await generate(
          [
            'En este turno NO se ha creado ninguna cita. No digas que está confirmada ni reservada. ' +
              'Si el cliente quiere reservar, usa propose_appointment y, cuando diga que sí, create_appointment.',
          ],
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
      // recorded -- that is what create_appointment books. Regenerate once,
      // requiring the tool.
      if (!bookedThisTurn && !proposedThisTurn && looksLikeSummary(generationResult.text)) {
        this.logger.warn(`Receptionist showed a summary without proposing it (${who}); regenerating`);
        const retried = await generate(
          ['Antes de mostrar el resumen llama a propose_appointment con los datos, y muestra exactamente el resumen que devuelva.'],
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

      // The model declined (Claude's safety classifiers): the provider's
      // fixed line, plus where the client can ask instead.
      if (generationResult.finishReason === 'refusal') {
        generationResult = { ...generationResult, text: `${generationResult.text}${this.callSalonSentence(salon)}` };
      }

      // Add assistant message to conversation. The time it took is kept so
      // the panel's average response time is measured, not assumed.
      await this.conversationService.addMessage(current.id, {
        role: 'assistant',
        content: generationResult.text,
        timestamp: new Date(),
        provider: generationResult.provider,
        responseTime: Date.now() - startTime,
      });

      // Update conversation handoff status
      if (requiresHandoff) {
        await this.conversationService.updateConversation(current.id, {
          status: 'handoff',
        });
      }

      const responseTime = Date.now() - startTime;

      this.logger.log(`Generated response for ${who} in ${responseTime}ms`);

      // P2A-receptionist-v2 H-4: dispatch the reply through the
      // appropriate channel provider. For Web, the message is rendered by
      // the frontend from the same response body (no separate send).
      const outbound = await this.channelRegistry
        .send(dto.salonId, current.channel as any, {
          externalUserId:
            (current.context as any)?.externalUserId ?? '',
          text: generationResult.text,
          ctx: {
            tenantId: dto.salonId,
            conversationId: current.id,
            recipientName: (current.context as any)?.recipientName,
            metadata: { channel: current.channel },
          },
        })
        .catch((err) => {
          const e = err as Error;
          this.logger.warn(
            `Channel dispatch failed for ${dto.salonId}/${current.channel}: ${e.message}`,
          );
          return null;
        });

      // Internal callers (the channels, the e2e harness) get the details;
      // the public chat endpoint passes on only what the widget needs.
      return {
        id: current.id,
        content: generationResult.text,
        provider: outbound?.messageId
          ? LLMProvider.SYSTEM
          : (generationResult.provider ?? LLMProvider.SYSTEM),
        model: generationResult.model,
        responseTime,
        requiresHandoff,
        intent: analysis.intent,
        channelDispatched: !!outbound,
        toolsExecuted: (generationResult as any).toolsExecuted,
      };

    } catch (error) {
      const err = error as Error;
      // The message only: the whole error object can carry the request.
      this.logger.error(`Error processing message from ${who}: ${err?.message ?? String(error)}`);

      // The appointment was booked before the failure (the model failed
      // writing the reply): say so from what the tool returned. The client
      // used to read "problemas técnicos" with the appointment made, and
      // booked again or called.
      const bookedNow = booked as Record<string, unknown> | null;
      const content = bookedNow
        ? this.bookedConfirmationText(bookedNow, salon)
        : this.configService.get('VIRTUAL_RECEPTIONIST_FALLBACK_MESSAGE') || this.technicalErrorText(salon);

      // The conversation keeps a reply for every message, the failures too.
      if (conversation) {
        await this.conversationService
          .addMessage(conversation.id, {
            role: 'assistant',
            content,
            timestamp: new Date(),
            provider: LLMProvider.SYSTEM,
            responseTime: Date.now() - startTime,
          })
          .catch((e: Error) => this.logger.warn(`Fallback reply not stored: ${e.message}`));
      }

      return {
        id: conversation?.id ?? 'error-response',
        content,
        provider: LLMProvider.SYSTEM,
        model: 'fallback',
        responseTime: Date.now() - startTime,
        requiresHandoff: !bookedNow,
        intent: ChatIntent.OTHER,
        // No error detail: this endpoint is public, and the widget showed
        // it to any visitor under "Debug:". It is in the log above.
      };
    }
  }

  /** The salon's name, phone and plan state, for the fixed replies. */
  private async salonContact(tenantId: string): Promise<SalonContact | null> {
    try {
      const t = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, phone: true, language: true, subscriptionStatus: true },
      });
      if (!t) return null;
      return {
        name: t.name,
        phone: t.phone?.trim() || null,
        language: t.language === 'en' ? 'en' : 'es',
        subscriptionStatus: (t.subscriptionStatus as string | null) ?? null,
      };
    } catch (err) {
      this.logger.warn(`Salon details not loaded for ${tenantId}: ${(err as Error).message}`);
      return null;
    }
  }

  /** " Puedes llamar al salón al …" when the salon has a phone; else "". */
  private callSalonSentence(salon: SalonContact | null): string {
    if (!salon?.phone) return '';
    return salon.language === 'en'
      ? ` You can call the salon on ${salon.phone}.`
      : ` Puedes llamar al salón al ${salon.phone}.`;
  }

  /** A salon whose subscription is not active. */
  private unavailableText(salon: SalonContact | null): string {
    const base = salon?.language === 'en' ? 'I cannot help you here right now.' : 'Ahora mismo no puedo atenderte por aquí.';
    return base + this.callSalonSentence(salon);
  }

  /** The model failed. No "contáctanos directamente" without saying how. */
  private technicalErrorText(salon: SalonContact | null): string {
    const en = salon?.language === 'en';
    const call = this.callSalonSentence(salon);
    if (en) return `I cannot reply right now.${call || ' Please try again in a few minutes.'}`;
    return `Ahora mismo no puedo responder.${call || ' Inténtalo de nuevo en unos minutos.'}`;
  }

  /**
   * The booking create_appointment made, in words, for when the model could
   * not write the reply: service, professional, day and time from the tool.
   */
  bookedConfirmationText(result: Record<string, unknown>, salon: SalonContact | null): string {
    const en = salon?.language === 'en';
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
    const service = str(result.service);
    const professional = str(result.professional);
    const location = str(result.location);
    const time = str(result.time);
    const date = str(result.date);
    let day = date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // "martes 10 de noviembre": the date is the salon's day, read as such.
      const at = new Date(`${date}T12:00:00Z`);
      const locale = en ? 'en-GB' : 'es-ES';
      const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(at);
      const dayMonth = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at);
      day = `${weekday} ${dayMonth}`;
    }
    const what = [service, professional ? (en ? `with ${professional}` : `con ${professional}`) : '']
      .filter(Boolean)
      .join(' ');
    const when = [day ? (en ? `on ${day}` : `el ${day}`) : '', time ? (en ? `at ${time}` : `a las ${time}`) : '']
      .filter(Boolean)
      .join(' ');
    const where = location ? ` (${location})` : '';
    const sent =
      result.confirmationEmailSent === true
        ? en ? ' We have sent you the confirmation by email.' : ' Te hemos enviado la confirmación por email.'
        : result.confirmationSmsSent === true
          ? en ? ' We have sent you the confirmation by SMS.' : ' Te hemos enviado la confirmación por SMS.'
          : '';
    const details = [what, when].filter(Boolean).join(', ');
    const said = details ? `: ${details}${where}` : '';
    const salonName = salon?.name || (en ? 'the salon' : 'el salón');
    // Pending until the salon confirms it (autoConfirmOnlineBookings off):
    // "reservada, pendiente de que {salón} la confirme", never "confirmada".
    if (result.confirmed === true) {
      return en ? `Your appointment is confirmed${said}.${sent}` : `Tu cita está confirmada${said}.${sent}`;
    }
    return en
      ? `Your appointment is booked, pending confirmation by ${salonName}${said}.${sent}`
      : `Tu cita queda reservada, pendiente de que ${salonName} la confirme${said}.${sent}`;
  }

  /** For a complaint: empathy, and the salon's phone instead of a promise. */
  private complaintNote(salon: SalonContact | null): string {
    return (
      'El cliente expresa una queja o un comentario. Muestra empatía y no intentes resolverlo tú. ' +
      'No digas que alguien del equipo se pondrá en contacto: nadie recibe esta conversación. ' +
      (salon?.phone
        ? `Dile que puede hablarlo con el salón llamando al ${salon.phone}.`
        : 'Dile que puede hablarlo directamente con el salón (get_salon_info tiene sus datos de contacto).')
    );
  }

  /**
   * P2A-receptionist-advanced H-2: when the client asks for suggestions,
   * services she could add, as a note for the model (Esencial without
   * ai_expansion gets none: the upsell service returns an empty list).
   */
  private async suggestionsNote(dto: SendMessageDto): Promise<string | null> {
    if (!asksForSuggestions(dto.message)) return null;
    const suggestions = await this.upsellService.suggest(dto.salonId, {
      clientId: dto.clientId,
      excludeServiceIds: dto.metadata?.serviceId ? [dto.metadata.serviceId] : undefined,
    });
    if (!suggestions || suggestions.length === 0) return null;
    const list = suggestions
      .map((s, i) => `${i + 1}. ${s.serviceName} (${s.duration} min) — ${s.price.toFixed(2)}€`)
      .join('; ');
    // The prices are final (upsell.service.ts): say once the tax is in them.
    const taxNote = suggestions[0].taxLabel ? ` Precios con ${suggestions[0].taxLabel} incluido.` : '';
    return (
      `El cliente pide sugerencias. Servicios del salón que puedes ofrecerle si encajan: ${list}.${taxNote} ` +
      'Si quiere reservar uno, sigue el flujo de reserva con las herramientas.'
    );
  }

  /** The conversation's latest proposal, if it has been booked. */
  private async bookedProposal(conversationId: string): Promise<{ time: string } | null> {
    const row = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { context: true },
    });
    const pending = (row?.context as any)?.pendingBooking;
    return pending?.bookedAppointmentId ? { time: String(pending.time) } : null;
  }

  /** The conversation's proposal from propose_appointment, if not booked yet. */
  private async pendingProposal(conversationId: string): Promise<PendingBooking | null> {
    const row = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { context: true },
    });
    const pending = (row?.context as any)?.pendingBooking as PendingBooking | undefined;
    return pending && !pending.bookedAppointmentId ? pending : null;
  }

  /**
   * The month's AI message cap for a tenant (trial, plan, AI packs), for
   * the billing dashboard's usage meter. The same number the receptionist
   * is gated on: AiConversationCounterService decides it.
   */
  async resolveEffectiveCap(tenantId: string): Promise<number | null> {
    return this.aiCounter.getEffectiveCap(tenantId);
  }

  /** Current month's AI conversation count for the tenant. */
  async getCurrentAiCount(tenantId: string): Promise<number> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: AI_USAGE_SELECT,
    });
    return aiUsageThisMonth(t);
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
   * Count one AI message against the tenant's caps, after the model has
   * answered. Not counting it is better than failing the reply.
   */
  private async countAiMessage(salonId: string): Promise<void> {
    try {
      await this.aiCounter.increment(salonId);
    } catch (err) {
      this.logger.warn(
        `AI counter increment failed (non-blocking): ${(err as Error).message}`,
      );
    }
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
    conversation: { id: string },
    salon: SalonContact | null,
  ): Promise<MessageResponseDto> {
    const clientName = dto.metadata && dto.metadata.clientName;
    const greeting = clientName
      ? `Hola ${clientName.split(' ')[0]}, `
      : '';
    // Said to the salon's client, who has no plan and no limit: the salon
    // is told about the cap separately (AiConversationCounterService). No
    // "le paso tu mensaje al equipo": nothing passes it on.
    const text =
      greeting +
      (greeting ? 'ahora mismo no puedo atenderte por aquí.' : 'Ahora mismo no puedo atenderte por aquí.') +
      this.callSalonSentence(salon);
    await this.conversationService.addMessage(conversation.id, {
      role: 'assistant',
      content: text,
      timestamp: new Date(),
      provider: 'AI_FAIRUSE_FALLBACK' as any,
    });
    return {
      id: conversation.id,
      content: text,
      provider: 'AI_FAIRUSE_FALLBACK' as any,
      model: 'fair-use-fallback',
      responseTime: 0,
      requiresHandoff: true,
      intent: ChatIntent.OTHER,
      limitInfo: {
        cap: decision.cap,
        used: decision.used,
        action: decision.fairUseAction,
      },
    };
  }
}
