import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { LLMService } from './services/llm.service';
import { ConversationService } from './services/conversation.service';
import { FAQService } from './services/faq.service';
import { BookingService } from './services/booking.service';
import { AnalysisService } from './services/analysis.service';
import { ProfessionalsService } from '../professionals/professionals.service';
import { SendMessageDto, MessageResponseDto, CreateConversationDto } from '@kira/shared';
import { ChatMessage, ChatIntent, LLMProvider, BookingStage, EntityType } from '@kira/shared';
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
          responseContent = await this.handleBookingIntent(dto, analysis);
          break;

        case ChatIntent.CANCEL_APPOINTMENT:
        case ChatIntent.RESCHEDULE_APPOINTMENT:
        case ChatIntent.CHECK_AVAILABILITY:
        case ChatIntent.CHECK_APPOINTMENT:
          responseContent = await this.handleAppointmentManagement(dto, analysis, conversation.id);
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

      // Check if conversation length requires handoff
      if (conversation.messages.length >= 20) {
        requiresHandoff = true;
      }

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
      const toolExecutor = (name: string, input: unknown) =>
        executeSalonTool(this.salonTools, name, input, {
          prisma: this.prisma,
          tenantId: dto.salonId,
          appointmentsService: this.appointmentsService,
        });
// P2A-receptionist-tools: the LLM needs to actually see the
      // user's message — previously the orchestrator passed the
      // intent-handler's prompt hint (which is often empty for
      // catalog queries) and the user's actual text was only
      // stored in the conversation history, which the LLM only
      // sees when there is prior context. For first turns the LLM
      // was responding to "" with a generic greeting. Combine both
      // here so the model always sees what the user actually asked.
      const userUtterance = responseContent
        ? `${responseContent}\n\nUsuario: ${dto.message}`
        : dto.message;

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
      const forcedTool = INTENT_TOOL[analysis.intent];
      const toolChoice: 'auto' | { type: 'tool'; name: string } =
        forcedTool && NO_PARAM_TOOLS.has(forcedTool)
          ? { type: 'tool', name: forcedTool }
          : 'auto';

      const generationResult = await this.llmService.generateResponse(
        userUtterance,
        conversation.messages,
        dto.salonId,
        undefined,
        {
          tools: SALON_TOOLS,
          executeTool: toolExecutor,
          maxToolIterations: 5,
          toolChoice,
        },
      );

      // Add assistant message to conversation
      await this.conversationService.addMessage(conversation.id, {
        role: 'assistant',
        content: generationResult.text,
        timestamp: new Date(),
        provider: generationResult.provider,
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
        // Surface the underlying error so the widget can show what
        // actually failed (LLM provider, network, DB, etc.). Trim
        // anything that could leak credentials.
        error: err?.message ? err.message.slice(0, 300) : 'unknown error',
      };
    }
  }

  private async handleBookingIntent(dto: SendMessageDto, analysis: any): Promise<string> {
    this.logger.log(`Handling booking intent for client ${dto.clientId}`);
    
    const existingBookingContext = await this.bookingService.getBookingContext(dto.clientId);
    
    if (!existingBookingContext) {
      // Start new booking process
      const context = await this.bookingService.createBookingContext({
        clientId: dto.clientId,
        salonId: dto.salonId,
        stage: BookingStage.INITIAL,
        serviceType: analysis.entities.find((e: any) => e.type === 'service_type')?.value,
        professional: analysis.entities.find((e: any) => e.type === 'professional')?.value,
        preferredDate: analysis.entities.find((e: any) => e.type === 'date')?.value,
        preferredTime: analysis.entities.find((e: any) => e.type === 'time')?.value,
        phoneNumber: analysis.entities.find((e: any) => e.type === 'phone')?.value,
        email: analysis.entities.find((e: any) => e.type === 'email')?.value,
        name: analysis.entities.find((e: any) => e.type === 'name')?.value,
      });
      
      return 'Â¡Hola! Â¿QuÃ© servicio te gustarÃ­a reservar? Ofrecemos servicios de belleza, spa, y masajes.';
    }

    // Continue existing booking process
    return this.bookingService.continueBookingProcess(existingBookingContext, analysis);
  }

  private async handleAppointmentManagement(
    dto: SendMessageDto,
    analysis: any,
    conversationId: string
  ): Promise<string> {
    this.logger.log(`Handling appointment management for client ${dto.clientId}`);

    if (analysis.intent === ChatIntent.CHECK_APPOINTMENT) {
      return await this.handleCheckAppointment(dto, analysis);
    }

    if (analysis.intent === ChatIntent.CHECK_AVAILABILITY) {
      // Ask the user for the service and date so we can look up real
      // slots, instead of returning a generic phone/email fallback
      // that the LLM would rephrase into a self-introduction.
      const clientName = dto.metadata?.clientName;
      const greeting = clientName ? `Hola ${clientName.split(' ')[0]}! ` : '¡Hola! ';
      return (
        `${greeting}Para consultar huecos disponibles necesito que me digas ` +
        `qué servicio te interesa y la fecha (por ejemplo "masaje mañana a las 11"). ` +
        `Si me dices solo "mañana" o "el viernes" te puedo enseñar los huecos de ese día.`
      );
    }

    // For other appointment management intents (cancel, reschedule)
    return 'Para gestionar tu cita, por favor contáctanos directamente al teléfono 123-456-7890 o por email info@ejemplo.com.';
  }
  
  private async handleCheckAppointment(dto: SendMessageDto, analysis: any): Promise<string> {
    this.logger.log(`Checking existing appointment for client ${dto.clientId}`);
    
    // Extract client information from metadata
    const clientName = dto.metadata?.clientName;
    const clientEmail = dto.metadata?.clientEmail;
    const clientPhone = dto.metadata?.clientPhone;
    
    // Extract date from message if provided
    const dateEntity = analysis.entities.find((e: any) => e.type === EntityType.DATE);
    const targetDate = dateEntity ? this.convertToDate(dateEntity.value) : null;
    
    try {
      // Query the database for existing appointments
      const appointments = await this.prisma.appointment.findMany({
        where: {
          clientId: dto.clientId,
          status: {
            in: ['pending', 'confirmed', 'in_progress']
          },
          ...(targetDate && {
            scheduledDate: {
              gte: new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0),
              lt: new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() + 1, 0, 0, 0, 0)
            }
          })
        },
        orderBy: {
          scheduledDate: 'asc'
        }
      });
      
      if (appointments.length > 0) {
        const personalizedGreeting = clientName ? `Hola ${clientName.split(' ')[0]}!` : 'Hola!';
        
        if (appointments.length === 1) {
          const appointment = appointments[0];
          const appointmentDate = this.formatDateForResponse(appointment.scheduledDate.toISOString().split('T')[0]);
          return `${personalizedGreeting} SÃ­, tienes una cita programada para el ${appointmentDate} a las ${appointment.scheduledTime}. Â¿Deseas modificarla o cancelarla?`;
        } else {
          // Multiple appointments
          const appointmentList = appointments.map(appointment => {
            const appointmentDate = this.formatDateForResponse(appointment.scheduledDate.toISOString().split('T')[0]);
            return `- ${appointmentDate} a las ${appointment.scheduledTime}`;
          }).join('\n');
          
          return `${personalizedGreeting} Tienes ${appointments.length} citas programadas:\n${appointmentList}\nÂ¿Deseas modificar o cancelar alguna de ellas?`;
        }
      } else {
        const personalizedFallback = clientName ? `Hola ${clientName.split(' ')[0]}!` : 'Hola!';
        return `${personalizedFallback} No encontramos una cita programada para ti. Â¿Deseas reservar una nueva cita?`;
      }
    } catch (error) {
      this.logger.error(`Error checking appointments for client ${dto.clientId}:`, error);
      const personalizedError = clientName ? `Hola ${clientName.split(' ')[0]}!` : 'Hola!';
      return `${personalizedError} Lo sentimos, no podemos verificar tus citas en este momento. Por favor, intÃ©ntalo de nuevo mÃ¡s tarde.`;
    }
  }
  
  private convertToDate(dateValue: string): Date | null {
    const lowerDate = dateValue.toLowerCase().trim();
    const today = new Date();
    
    // Handle specific date formats (dd/mm/yyyy or dd-mm-yyyy)
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(lowerDate)) {
      const [day, month, year] = lowerDate.split(/[\/\-]/).map(Number);
      return new Date(year, month - 1, day);
    }
    
    // Handle relative days
    if (lowerDate === 'hoy') {
      return new Date(today.getFullYear(), today.getMonth(), today.getDate());
    }
    if (lowerDate === 'maÃ±ana') {
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    }
    if (lowerDate === 'ayer') {
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    }
    
    // Handle day names (Spanish)
    const dayNames = ['domingo', 'lunes', 'martes', 'miÃ©rcoles', 'jueves', 'viernes', 'sÃ¡bado'];
    const targetDayIndex = dayNames.indexOf(lowerDate);
    
    if (targetDayIndex !== -1) {
      const todayIndex = today.getDay();
      let daysToAdd = targetDayIndex - todayIndex;
      
      // If target day is before current day, go to next week
      if (daysToAdd <= 0) {
        daysToAdd += 7;
      }
      
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysToAdd);
    }
    
    return null;
  }

  private formatDateForResponse(dateStr: string): string {
    // Simple date formatting for response
    const lowerDate = dateStr.toLowerCase();
    
    if (lowerDate === 'maÃ±ana') return 'maÃ±ana';
    if (lowerDate === 'ayer') return 'ayer';
    if (lowerDate === 'hoy') return 'hoy';
    
    return dateStr; // Return original if no special format
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

  /**
   * Read the tenant's live Service catalog and answer price / info
   * questions with real data. Returns null when the catalog lookup
   * can't be performed (invalid tenantId, no services, etc.) so the
   * caller can fall back to FAQ / generic.
   */
  private async handleServiceCatalogQuery(
    dto: SendMessageDto,
    analysis: any,
    clientName?: string,
  ): Promise<string | null> {
    const tenantId = dto.salonId;
    if (!tenantId) return null;

    // Cheap guard so we don't hit the DB with garbage from the widget.
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId);
    if (!looksLikeUuid) return null;

    let services;
    try {
      services = await this.prisma.service.findMany({
        where: { tenantId, isActive: true },
        orderBy: [{ category: 'asc' }, { price: 'asc' }],
        select: {
          name: true,
          description: true,
          category: true,
          duration: true,
          price: true,
          currency: true,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Service catalog lookup failed for tenant ${tenantId}: ${(err as Error).message}`,
      );
      return null;
    }

    if (!services.length) return null;

    // Build a haystack of the user's message + extracted SERVICE_TYPE
    // entities + keywords to fuzzy-match against the service names.
    const userText = [
      dto.message ?? '',
      ...((analysis?.entities ?? [])
        .filter((e: any) => e?.type === EntityType.SERVICE_TYPE)
        .map((e: any) => String(e.value ?? ''))),
      ...((analysis?.keywords ?? []).map((k: any) => String(k))),
    ]
      .join(' ')
      .toLowerCase();

    const normalize = (s: string) =>
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    const tokens = new Set(
      normalize(userText)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3),
    );

    // P2A-receptionist-gender: detect gender / audience markers in the
    // user message ("hombre", "mujer", "caballero", "nino", "nina",
    // "damas", "caballeros") so we can:
    //   1) boost services that match the requested audience, and
    //   2) filter out services whose own name says the opposite gender,
    //      so "corte de pelo para hombre" doesn't surface "Corte de
    //      Cabello Mujer".
    const userGender = detectGender(normalize(userText));
    const FEMALE = 'female';
    const MALE = 'male';
    const CHILD = 'child';

    const audienceFromServiceName = (name: string): string | null => {
      const n = normalize(name);
      if (/\b(mujer|damas|senora|senorita|femenin[oa]?)\b/.test(n)) return FEMALE;
      if (/\b(hombre|caballero|varon|masculin[oa]?|chico)\b/.test(n)) return MALE;
      if (/\b(nin[oa]|infantil|kids?|bebe)\b/.test(n)) return CHILD;
      return null;
    };

    const compatible = (svcAudience: string | null) => {
      if (!userGender || !svcAudience) return true;
      // "para hombre" must not match a service explicitly for women.
      if (userGender === MALE && svcAudience === FEMALE) return false;
      if (userGender === FEMALE && svcAudience === MALE) return false;
      // Adult request shouldn't pull a kids' service.
      if (userGender !== CHILD && svcAudience === CHILD) return false;
      return true;
    };

    // Word-level prefix match so "masajes" matches "Masaje Relajante"
    // and "cortes" matches "Corte de Cabello". The token and the
    // service word must share at least 4 chars of prefix.
    const matchesWord = (token: string, word: string): boolean => {
      if (!token || !word) return false;
      if (token === word) return true;
      const min = Math.min(token.length, word.length);
      if (min < 4) return false;
      const shorter = min === token.length ? token : word;
      const longer = min === token.length ? word : token;
      return longer.startsWith(shorter);
    };

    const scored = services
      .map((s) => {
        const name = normalize(s.name);
        const desc = normalize(s.description ?? '');
        const nameWords = name.split(/\s+/).filter(Boolean);
        const descWords = desc.split(/\s+/).filter(Boolean);
        const svcAudience = audienceFromServiceName(s.name);
        let score = 0;
        for (const t of tokens) {
          if (nameWords.some((w) => matchesWord(t, w))) score += 3;
          if (descWords.some((w) => matchesWord(t, w))) score += 1;
        }
        // Boost when the service's audience matches what the user asked.
        if (userGender && svcAudience === userGender) score += 6;
        // Hard filter: opposite gender -> exclude entirely.
        if (!compatible(svcAudience)) score = -1;
        return { service: s, score, svcAudience };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    const greeting = clientName ? `Hola ${clientName.split(' ')[0]}! ` : '¡Hola! ';
    const formatPrice = (price: any) =>
      `${Number(price).toFixed(2)} ${services[0].currency || 'EUR'}`;

    // Detect the user's service intent keywords ("corte", "pelo",
    // "manicura", etc.) so we can decide whether to acknowledge the
    // ask explicitly when the catalog has no match.
    const serviceIntent = /\b(corte|pelo|cabello|manicura|pedicura|unas|tinte|color|mecha|balayage|alisado|peinado|facial|limpieza|masaje|depilacion|depilaci[oó]n|tratamiento|keratina|servicio)\b/.test(
      userText,
    );

    // Specific hit: tell the user the price of the matching service(s).
    if (scored.length > 0 && scored[0].score >= 3) {
      const top = scored.slice(0, 3).map((s) => s.service);
      const lines = top.map(
        (s) => `• ${s.name} — ${formatPrice(s.price)} (${s.duration} min)`,
      );
      return (
        `${greeting}Claro, en nuestro salón ${top.length === 1 ? 'este es el precio' : 'estos son los precios'}:\n` +
        lines.join('\n') +
        (top.length === 1 && top[0].description
          ? `\n${top[0].description}`
          : '') +
        `\n¿Quieres que te reserve un hueco?`
      );
    }

    // P2A-receptionist-honest: the user named a service but the catalog
    // has no compatible match. Don't dump unrelated services; be
    // explicit about not having it, and offer the closest option.
    if (serviceIntent && tokens.size > 0 && userGender) {
      const strongestMatch = services
        .map((s) => {
          const name = normalize(s.name);
          const desc = normalize(s.description ?? '');
          const nameWords = name.split(/\s+/).filter(Boolean);
          const descWords = desc.split(/\s+/).filter(Boolean);
          let score = 0;
          for (const t of tokens) {
            if (nameWords.some((w) => matchesWord(t, w))) score += 1;
            if (descWords.some((w) => matchesWord(t, w))) score += 1;
          }
          return { service: s, score };
        })
        .sort((a, b) => b.score - a.score)[0];

      const genderWord =
        userGender === MALE ? 'para hombre' :
        userGender === FEMALE ? 'para mujer' :
        'infantil';

      // If the highest-scoring service is a "close" hit (covers part
      // of the request but a different audience), suggest it
      // explicitly so the user knows it exists.
      if (strongestMatch && strongestMatch.score >= 1) {
        const svc = strongestMatch.service;
        return (
          `${greeting}Lo siento, no tenemos un corte de pelo ${genderWord} en este momento, ` +
          `pero tenemos "${svc.name}" a ${formatPrice(svc.price)} (${svc.duration} min). ` +
          `¿Te interesa o prefieres que te apunte para avisarte cuando lo tengamos?`
        );
      }

      return (
        `${greeting}Lo siento, ahora mismo no tenemos servicios de ese tipo disponibles ` +
        `(${genderWord}). ¿Quieres que te apunte para avisarte cuando lo tengamos en el catálogo?`
      );
    }

    // No specific match and no gender filter: list the full catalog
    // so the user can pick.
    const list = services
      .slice(0, 12)
      .map((s) => `• ${s.name} — ${formatPrice(s.price)} (${s.duration} min)`)
      .join('\n');
    return (
      `${greeting}Estos son los servicios disponibles y sus precios:\n${list}\n` +
      `¿Cuál te interesa? Si me dices el nombre te busco hueco.`
    );
  }

  private async handleProfessionalInfoQuery(dto: SendMessageDto, analysis: any, clientName: string): Promise<string> {
    this.logger.log(`Handling professional info query for client ${dto.clientId}`);
    
    // Extract professional name from entities
    const professionalEntity = analysis.entities.find((e: any) => e.type === EntityType.PROFESSIONAL);
    
    if (professionalEntity) {
      // Find professional by name
      const professional = await this.professionalsService.findProfessionalByName(dto.salonId, professionalEntity.value);
      
      if (professional) {
        const personalizedGreeting = clientName ? `Hola ${clientName.split(' ')[0]}! ` : '';
        return `${personalizedGreeting}${professional.firstName} ${professional.lastName} es nuestro ${professional.position || 'especialista'}.`;
      }
    }
    
    // Get all active professionals
    const professionals = await this.professionalsService.getActiveProfessionalsBySalon(dto.salonId);
    
    if (professionals.length > 0) {
      const professionalNames = professionals.map(p => `${p.firstName} ${p.lastName}`).join(', ');
      const personalizedGreeting = clientName ? `Hola ${clientName.split(' ')[0]}! ` : '';
      return `${personalizedGreeting}Nuestros profesionales son: ${professionalNames}. Â¿Con quiÃ©n te gustarÃ­a reservar?`;
    }
    
    const personalizedFallback = clientName ? `Hola ${clientName.split(' ')[0]}! ` : '';
    return `${personalizedFallback}Lo sentimos, no tenemos informaciÃ³n sobre profesionales en este momento. Por favor, contÃ¡ctanos directamente.`;
  }

  private async handleComplaintOrFeedback(dto: SendMessageDto, analysis: any): Promise<string> {
    this.logger.log(`Handling complaint/feedback for client ${dto.clientId}`);
    
    return 'Lo sentimos por la inconveniencia. Un miembro de nuestro equipo se pondrÃ¡ en contacto contigo pronto.';
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
        const greeting = clientName ? `Hola ${clientName.split(' ')[0]}! ` : '¡Hola! ';
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
    const personalizedGreeting = clientName ? `¡Hola ${clientName.split(' ')[0]}!` : '¡Hola!';
    return `${personalizedGreeting} ¿En qué puedo ayudarte hoy?`;
  }

  /**
   * Get virtual receptionist configuration for a salon
   */
  async getConfig(salonId: string): Promise<any> {
    // This should fetch configuration from database or configuration service
    return {
      id: 'default-config',
      salonId,
      isActive: true,
      provider: 'openai',
      model: 'gpt-4',
      greetingMessage: 'Â¡Hola! Â¿En quÃ© puedo ayudarte hoy?',
      fallbackMessage: 'Lo sentimos, estamos experimentando problemas.',
      responseDelay: 1000,
      workingHours: {
        monday: { start: '09:00', end: '18:00' },
        tuesday: { start: '09:00', end: '18:00' },
        wednesday: { start: '09:00', end: '18:00' },
        thursday: { start: '09:00', end: '18:00' },
        friday: { start: '09:00', end: '18:00' },
        saturday: { start: '09:00', end: '14:00' },
        sunday: { start: 'closed', end: 'closed' },
      },
      excludedKeywords: [],
      faqTopics: ['services', 'hours', 'location', 'prices'],
      maxConversationLength: 20,
      allowAppointmentBooking: true,
      appointmentTimeSlots: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Create virtual receptionist configuration
   */
  async createConfig(config: any): Promise<any> {
    this.logger.log(`Creating virtual receptionist configuration for salon ${config.salonId}`);
    return config;
  }

  /**
   * Update virtual receptionist configuration
   */
  async updateConfig(salonId: string, config: any): Promise<any> {
    this.logger.log(`Updating virtual receptionist configuration for salon ${salonId}`);
    return config;
  }

  /**
   * Get virtual receptionist statistics
   */
  async getStatistics(): Promise<any> {
    const conversations = await this.conversationService.getConversationCount();
    const messages = await this.conversationService.getMessageCount();
    const bookings = await this.bookingService.getBookingCount();

    return {
      conversations: conversations.total,
      activeConversations: conversations.active,
      messages: messages.total,
      userMessages: messages.user,
      assistantMessages: messages.assistant,
      bookings,
      avgResponseTime: 1500,
      handoffRate: 15.2,
      faqHitRate: 35.8,
    };
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

/**
 * Detect gender / audience markers in an already-normalized (lower,
 * accent-stripped) user message. Returns 'male', 'female', 'child',
 * or null if no marker is present.
 */
function detectGender(normalizedText: string): 'male' | 'female' | 'child' | null {
  // Order matters: most specific first.
  if (/\b(nin[oa]|infantil|kids?|bebe|pequen[oa])\b/.test(normalizedText)) return 'child';
  if (/\b(hombre|hombres|caballero|caballeros|varon|chico|masculin[oa]?)\b/.test(normalizedText)) return 'male';
  if (/\b(mujer|mujeres|damas|senora|senorita|senoras|femenin[oa]?|chica)\b/.test(normalizedText)) return 'female';
  return null;
}

/**
 * True when the raw user message contains an explicit gender / audience
 * marker. Used by the orchestrator to recognise short follow-ups
 * ("y para un hombre?") as catalog queries instead of generic greetings.
 */
function hasGenderMarker(rawText: string): boolean {
  const t = rawText
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return detectGender(t) !== null;
}