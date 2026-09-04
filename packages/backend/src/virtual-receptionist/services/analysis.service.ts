import { Injectable, Logger } from '@nestjs/common';
import { ChatIntent, MessageAnalysis, EntityType, ChatMessage } from '@kira/shared';

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  /**
   * Analyze message intent and entities
   */
  async analyzeMessage(message: string): Promise<MessageAnalysis> {
    const startTime = Date.now();

    try {
      const analysis = this.analyzeMessageContent(message);
      const latency = Date.now() - startTime;

      this.logger.log(`Message analyzed in ${latency}ms`);
      return analysis;
    } catch (error) {
      this.logger.error('Error analyzing message:', error);
      return this.getDefaultAnalysis();
    }
  }

  private analyzeMessageContent(message: string): MessageAnalysis {
    const lowerMsg = message.toLowerCase();
    const analysis: MessageAnalysis = {
      intent: this.determineIntent(lowerMsg),
      entities: this.extractEntities(lowerMsg),
      sentiment: this.analyzeSentiment(lowerMsg),
      confidence: 0.85, // Default high confidence for heuristic analysis
      requiresHandoff: this.detectRequiresHandoff(lowerMsg),
      keywords: this.extractKeywords(lowerMsg),
    };

    return analysis;
  }

  private determineIntent(message: string): ChatIntent {
    // Check existing appointments
    if (message.includes('tengo cita') || message.includes('¿tengo cita') ||
        message.includes('check appointment') || message.includes('mi cita')) {
      return ChatIntent.CHECK_APPOINTMENT;
    }

    // Booking and appointment management. "quiero un corte", "dame un
    // masaje", "me gustaría..." and "pedir" are all user intent to
    // book; if the message also references a service entity, fall
    // through to SERVICE_INFO so the bot shows prices first.
    const bookingVerbs = [
      'reserve', 'reservar', 'book', 'agendar', 'reserva', 'cita',
      'pedir', 'contratar', 'solicitar',
    ];
    const hasBookingVerb = bookingVerbs.some((v) => message.includes(v));
    const serviceHints = [
      'corte', 'pelo', 'cabello', 'manicura', 'pedicura', 'unas',
      'tinte', 'color', 'mecha', 'balayage', 'alisado', 'peinado',
      'facial', 'limpieza', 'masaje', 'depilacion', 'depilación',
      'tratamiento', 'keratina', 'keratina',
    ];
    const hasServiceHint = serviceHints.some((s) => message.includes(s));

    if (hasBookingVerb && hasServiceHint) {
      return ChatIntent.BOOK_APPOINTMENT;
    }
    if (bookingVerbs.some((v) => message.includes(v))) {
      return ChatIntent.BOOK_APPOINTMENT;
    }
    // "Quiero un corte de pelo para hombre" / "Me gustaría un masaje"
    // express interest in a service. Route to SERVICE_INFO so the
    // catalog is consulted instead of falling into the generic
    // greeting, but only when the message contains a service hint.
    const interestVerbs = ['quiero', 'dame', 'me gustaria', 'me gustaría', 'busco', 'necesito'];
    if (interestVerbs.some((v) => message.includes(v)) && hasServiceHint) {
      return ChatIntent.SERVICE_INFO;
    }

    // "Y masajes ofrecen?", "Qué cortes tienen?", "Hay manicura?",
    // "Cuánto cuesta..." are short availability / catalog queries.
    // Route to SERVICE_INFO when the message combines an availability
    // verb with a service hint so the catalog handler can answer
    // with the actual list (and apply the gender filter from prior
    // turns).
    const availabilityVerbs = [
      'ofrecen', 'ofrecéis', 'tienen', 'teneis', 'hay', 'hacen', 'hacéis',
      'haces', 'haráis', 'dan', 'cuales', 'cuáles', 'que hay', 'qué hay',
      'tienes', 'tienes?', 'venden', 'sirven', 'disponen', 'cuentan con',
      'puede', 'pueden', 'puedo', 'acepta', 'aceptan', 'tambien',
    ];
    if (availabilityVerbs.some((v) => message.includes(v)) && hasServiceHint) {
      return ChatIntent.SERVICE_INFO;
    }

    // "Y para niños?", "Y para mi hija?", "Niños también?", "Y los
    // peques?" express interest in a sub-catalog (children / family).
    // Route to SERVICE_INFO so the catalog handler applies the
    // `child` gender filter and lists only matching services.
    const childMarkers = [
      'niño', 'niños', 'niña', 'niñas', 'nin', 'nino', 'nina',
      'peque', 'peques', 'infantil', 'kids', 'bebe', 'bebé',
      'hija', 'hijo', 'hijos', 'hijas',
    ];
    if (childMarkers.some((m) => message.includes(m))) {
      return ChatIntent.SERVICE_INFO;
    }

    // Short single-word or short-phrase service queries (no verb,
    // no availability keyword) — "Pies", "Coloración completa",
    // "Manicura", "Tinte". The catalog handler will still match by
    // token overlap so the user gets the actual prices.
    const wordCount = message.split(/\s+/).filter(Boolean).length;
    if (
      wordCount <= 4 &&
      hasServiceHint &&
      !bookingVerbs.some((v) => message.includes(v))
    ) {
      return ChatIntent.SERVICE_INFO;
    }

    if (message.includes('cancel') || message.includes('cancelar') || 
        message.includes('eliminar') || message.includes('anular')) {
      return ChatIntent.CANCEL_APPOINTMENT;
    }

    if (message.includes('cambiar') || message.includes('modificar') || 
        message.includes('reprogramar') || message.includes('change')) {
      return ChatIntent.RESCHEDULE_APPOINTMENT;
    }

    if (
      message.includes('disponibilidad') ||
      message.includes('disponible') ||
      message.includes('disponibles') ||
      message.includes('hueco') ||
      message.includes('huecos') ||
      message.includes('horario') ||
      message.includes('horarios') ||
      message.includes('espacio') ||
      message.includes('agenda') ||
      message.includes('libre') ||
      message.includes('libres') ||
      message.includes('when') ||
      message.includes('available') ||
      message.includes('available') ||
      message.includes('hour') ||
      message.includes('hours') ||
      message.includes('slot') ||
      message.includes('slots')
    ) {
      return ChatIntent.CHECK_AVAILABILITY;
    }

    // Check existing appointments
    if (message.includes('tengo cita') || message.includes('¿tengo cita') || 
        message.includes('check appointment') || message.includes('mi cita')) {
      return ChatIntent.CHECK_APPOINTMENT;
    }

    // Service and pricing information
    if (message.includes('precio') || message.includes('cost') || 
        message.includes('price') || message.includes('cuánto cuesta')) {
      return ChatIntent.PRICE_QUERY;
    }

    if (message.includes('servicio') || message.includes('service') || 
        message.includes('tratamiento') || message.includes('treatment')) {
      return ChatIntent.SERVICE_INFO;
    }

    // Professional information
    if (message.includes('profesional') || message.includes('professional') || 
        message.includes('peluquero') || message.includes('estilista') || 
        message.includes('masajista') || message.includes('especialista')) {
      return ChatIntent.PROFESSIONAL_INFO;
    }

    // Contact and location information
    if (message.includes('dirección') || message.includes('address') || 
        message.includes('ubicación') || message.includes('location')) {
      return ChatIntent.LOCATION_INFO;
    }

    if (message.includes('teléfono') || message.includes('phone') || 
        message.includes('contacto') || message.includes('email')) {
      return ChatIntent.CONTACT_INFO;
    }

    // Hours and schedule
    if (message.includes('horario') || message.includes('hours') || 
        message.includes('abierto') || message.includes('cerrado')) {
      return ChatIntent.HOURS_INFO;
    }

    // Complaints and feedback
    if (message.includes('reclamo') || message.includes('queja') || 
        message.includes('problema') || message.includes('malo')) {
      return ChatIntent.COMPLAINT;
    }

    if (message.includes('comentario') || message.includes('feedback') || 
        message.includes('opinión') || message.includes('recomendar')) {
      return ChatIntent.FEEDBACK;
    }

    // Default intent
    return ChatIntent.OTHER;
  }

  private extractEntities(message: string): any[] {
    const entities: any[] = [];

    // Extract phone numbers
    const phonePattern = /(\+?\d{1,3}[-.\s]?)?(\(?\d{2,3}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}/g;
    const phoneMatches = message.match(phonePattern);
    if (phoneMatches) {
      phoneMatches.forEach(phone => {
        entities.push({
          type: EntityType.PHONE,
          value: phone.replace(/[-.\s()]/g, ''),
          confidence: 0.95,
        });
      });
    }

    // Extract email addresses
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emailMatches = message.match(emailPattern);
    if (emailMatches) {
      emailMatches.forEach(email => {
        entities.push({
          type: EntityType.EMAIL,
          value: email,
          confidence: 0.95,
        });
      });
    }

    // Extract dates and times (simple implementation)
    const datePattern = /(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\-\d{1,2}\-\d{4}|mañana|ayer|hoy)/g;
    const dateMatches = message.match(datePattern);
    if (dateMatches) {
      dateMatches.forEach(date => {
        entities.push({
          type: EntityType.DATE,
          value: date,
          confidence: 0.8,
        });
      });
    }

    // Extract day names (Spanish)
    const dayNames = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
    dayNames.forEach(dayName => {
      if (message.includes(dayName)) {
        entities.push({
          type: EntityType.DATE,
          value: dayName,
          confidence: 0.85,
        });
      }
    });

    // Extract service types
    const services = ['cabello', 'pelo', 'manos', 'pies', 'uñas', 'masaje', 'facial'];
    services.forEach(service => {
      if (message.includes(service)) {
        entities.push({
          type: EntityType.SERVICE_TYPE,
          value: service,
          confidence: 0.85,
        });
      }
    });

    // Extract professional names and references
    const professionalPattern = /(?:con\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/g;
    const professionalMatches = message.match(professionalPattern);
    if (professionalMatches) {
      professionalMatches.forEach(match => {
        const trimmedMatch = match.replace(/^con\s+/, '').trim();
        if (trimmedMatch.length > 2 && !services.some(service => service.includes(trimmedMatch.toLowerCase()))) {
          entities.push({
            type: EntityType.PROFESSIONAL,
            value: trimmedMatch,
            confidence: 0.7,
          });
        }
      });
    }

    return entities;
  }

  private analyzeSentiment(message: string): 'positive' | 'negative' | 'neutral' {
    const positiveWords = ['buen', 'excelente', 'me gusta', 'maravilloso', 'fantástico'];
    const negativeWords = ['malo', 'horrible', 'no me gusta', 'pésimo', 'terrible'];

    const positiveCount = positiveWords.filter(word => message.includes(word)).length;
    const negativeCount = negativeWords.filter(word => message.includes(word)).length;

    if (positiveCount > negativeCount) return 'positive';
    if (negativeCount > positiveCount) return 'negative';
    return 'neutral';
  }

  private detectRequiresHandoff(message: string): boolean {
    const handoffKeywords = [
      'hablar con', 'quiero hablar', 'agente', 'representante', 'personal',
      'ayuda humana', 'necesito ayuda', 'problema serio', 'emergencia'
    ];

    return handoffKeywords.some(keyword => message.includes(keyword));
  }

  private extractKeywords(message: string): string[] {
    const words = message.split(/\s+/);
    const filteredWords = words
      .map(word => word.toLowerCase().replace(/[.,!?()"]/g, ''))
      .filter(word => word.length > 3);

    const uniqueWords = [...new Set(filteredWords)];
    return uniqueWords.slice(0, 10);
  }

  private getDefaultAnalysis(): MessageAnalysis {
    return {
      intent: ChatIntent.OTHER,
      entities: [],
      sentiment: 'neutral',
      confidence: 0.5,
      requiresHandoff: false,
      keywords: [],
    };
  }
}