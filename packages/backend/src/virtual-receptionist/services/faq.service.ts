import { Injectable, Logger } from '@nestjs/common';
import { CreateFAQItem, UpdateFAQItem, FAQItemResponse } from '@kira/shared';
import { FAQItem } from '@kira/shared';

@Injectable()
export class FAQService {
  private readonly logger = new Logger(FAQService.name);
  private faqItems: Map<string, FAQItem> = new Map();

  constructor() {
    this.initializeDefaultFAQs();
  }

  /**
   * Initialize default FAQ items
   */
  private initializeDefaultFAQs(): void {
    const defaultFAQs: FAQItem[] = [
      {
        id: 'faq-1',
        salonId: 'default',
        question: '¿Cuáles son sus horarios de atención?',
        answer: 'Estamos abiertos de lunes a viernes de 9:00 a 18:00, y sábados de 9:00 a 14:00. Los domingos estamos cerrados.',
        category: 'horarios',
        keywords: ['horario', 'horarios', 'atencion', 'abierto', 'cerrado'],
        priority: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'faq-2',
        salonId: 'default',
        question: '¿Qué servicios ofrecen?',
        answer: 'Ofrecemos una amplia variedad de servicios de belleza, incluyendo cortes de cabello, peinados, coloraciones, manicuras, pedicuras, masajes relajantes y faciales. También contamos con tratamientos especializados.',
        category: 'servicios',
        keywords: ['servicios', 'ofrecer', 'cortes', 'peinados', 'coloraciones'],
        priority: 2,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'faq-3',
        salonId: 'default',
        question: '¿Qué métodos de pago aceptan?',
        answer: 'Aceptamos efectivo, tarjetas de crédito y débito (Visa, Mastercard, American Express). También puedes pagar con transferencia bancaria.',
        category: 'pago',
        keywords: ['pago', 'metodos', 'tarjeta', 'efectivo', 'transferencia'],
        priority: 3,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'faq-4',
        salonId: 'default',
        question: '¿Cómo puedo reservar una cita?',
        answer: 'Puedes reservar una cita directamente a través de nuestra página web, por teléfono al (555) 123-4567, o mediante este chat virtual. Te pediremos algunos datos básicos para confirmar tu reservación.',
        category: 'reservas',
        keywords: ['reservar', 'cita', 'agendar', 'book', 'appointment'],
        priority: 4,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'faq-5',
        salonId: 'default',
        question: '¿Cuánto tiempo dura un servicio promedio?',
        answer: 'La duración depende del tipo de servicio. Un corte de cabello promedio dura entre 30 y 45 minutos, mientras que un peinado o coloración puede durar hasta 2 horas. Los masajes duran entre 30 y 90 minutos.',
        category: 'duracion',
        keywords: ['tiempo', 'duracion', 'promedio', 'cuanto', 'horas'],
        priority: 5,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'faq-6',
        salonId: 'default',
        question: '¿Tienen descuentos o promociones?',
        answer: 'Si, ofrecemos descuentos para clientes recurrentes y promociones especiales durante el año. También tenemos paquetes combinados de servicios con descuento.',
        category: 'descuentos',
        keywords: ['descuento', 'promociones', 'oferta', 'especial', 'paquetes'],
        priority: 6,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'faq-7',
        salonId: 'default',
        question: '¿Quiénes son sus profesionales?',
        answer: 'Contamos con una equipe de profesionales altamente capacitados, incluyendo peluqueros, estilistas, manicuristas, pedicuristas y masajistas especializados en diferentes áreas de la belleza.',
        category: 'profesionales',
        keywords: ['profesionales', 'equipo', 'especialistas', 'peluqueros', 'estilistas'],
        priority: 7,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'faq-8',
        salonId: 'default',
        question: '¿Con qué profesional puedo reservar?',
        answer: 'Podrás reservar con cualquier profesional de nuestra equipe. Si tienes una preferencia, por favor menciona el nombre del profesional al momento de reservar.',
        category: 'profesionales',
        keywords: ['reservar', 'profesional', 'preferencia', 'nombre'],
        priority: 8,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    defaultFAQs.forEach(faq => {
      this.faqItems.set(faq.id, faq);
    });

    this.logger.log(`Initialized ${defaultFAQs.length} default FAQ items`);
  }

  /**
   * Find FAQ match for a given query
   */
  async findFAQMatch(salonId: string, analysis: any): Promise<FAQItem | null> {
    const faqs = this.getFAQsForSalon(salonId);
    const bestMatch = this.findBestMatch(faqs, analysis);
    
    if (bestMatch) {
      this.logger.log(`FAQ match found: ${bestMatch.id}`);
    }
    
    return bestMatch;
  }

  /**
   * Find best matching FAQ using keyword matching
   */
  private findBestMatch(faqs: FAQItem[], analysis: any): FAQItem | null {
    const queryKeywords = analysis.keywords;
    
    if (!queryKeywords || queryKeywords.length === 0) {
      return null;
    }

    let bestMatch: FAQItem | null = null;
    let bestScore = 0;

    faqs.forEach(faq => {
      let score = 0;

      // Check keyword matches
      const faqKeywords = faq.keywords;
      queryKeywords.forEach(keyword => {
        if (faqKeywords.some(faqKeyword => 
            faqKeyword.toLowerCase().includes(keyword.toLowerCase()))) {
          score += 2;
        }
      });

      // Check intent match
      if (analysis.intent) {
        const intentKeywords = this.getIntentKeywords(analysis.intent);
        if (intentKeywords.some(keyword => 
            faq.question.toLowerCase().includes(keyword.toLowerCase()))) {
          score += 1;
        }
      }

      // Check question match
      if (analysis.entities.length > 0) {
        analysis.entities.forEach((entity: any) => {
          if (faq.question.toLowerCase().includes(entity.value.toLowerCase())) {
            score += 0.5;
          }
        });
      }

      // Give priority to active FAQs and lower priority numbers
      score += (10 - faq.priority) * 0.1;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = faq;
      }
    });

    return bestScore > 1.5 ? bestMatch : null;
  }

  /**
   * Get intent-specific keywords for FAQ matching
   */
  private getIntentKeywords(intent: string): string[] {
    const intentKeywordMap: { [key: string]: string[] } = {
      BOOK_APPOINTMENT: ['reservar', 'cita', 'agendar'],
      CANCEL_APPOINTMENT: ['cancelar', 'eliminar', 'anular'],
      RESCHEDULE_APPOINTMENT: ['cambiar', 'modificar', 'reprogramar'],
      CHECK_AVAILABILITY: ['disponibilidad', 'horario', 'cuando'],
      PRICE_QUERY: ['precio', 'coste', 'cuanto cuesta'],
      SERVICE_INFO: ['servicios', 'ofrecer', 'tratamiento'],
      HOURS_INFO: ['horario', 'atencion', 'abierto'],
      LOCATION_INFO: ['direccion', 'ubicacion', 'donde'],
      CONTACT_INFO: ['contacto', 'telefono', 'email'],
      COMPLAINT: ['reclamo', 'queja', 'problema'],
      FEEDBACK: ['comentario', 'feedback', 'opinion'],
    };

    return intentKeywordMap[intent] || [];
  }

  /**
   * Get FAQs for a specific salon
   */
  private getFAQsForSalon(salonId: string): FAQItem[] {
    return Array.from(this.faqItems.values())
      .filter(faq => faq.salonId === salonId || faq.salonId === 'default')
      .filter(faq => faq.isActive);
  }

  /**
   * Create FAQ item
   */
  async createFAQ(data: CreateFAQItem): Promise<FAQItemResponse> {
    const newFAQ: FAQItem = {
      id: this.generateId(),
      salonId: 'default', // Default for now
      ...data,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.faqItems.set(newFAQ.id, newFAQ);
    this.logger.log(`FAQ created: ${newFAQ.id}`);
    
    return this.toResponse(newFAQ);
  }

  /**
   * Get all FAQs
   */
  async getFAQs(salonId?: string): Promise<FAQItemResponse[]> {
    const faqs = salonId 
      ? this.getFAQsForSalon(salonId)
      : Array.from(this.faqItems.values()).filter(faq => faq.isActive);
    
    return faqs.map(this.toResponse.bind(this));
  }

  /**
   * Get FAQ by ID
   */
  async getFAQ(id: string): Promise<FAQItemResponse | null> {
    const faq = this.faqItems.get(id);
    if (!faq) {
      this.logger.warn(`FAQ not found: ${id}`);
      return null;
    }
    return this.toResponse(faq);
  }

  /**
   * Update FAQ item
   */
  async updateFAQ(id: string, data: UpdateFAQItem): Promise<FAQItemResponse | null> {
    const faq = this.faqItems.get(id);
    
    if (!faq) {
      this.logger.warn(`FAQ not found: ${id}`);
      return null;
    }

    const updatedFAQ = {
      ...faq,
      ...data,
      updatedAt: new Date(),
    };

    this.faqItems.set(id, updatedFAQ);
    this.logger.log(`FAQ updated: ${id}`);
    
    return this.toResponse(updatedFAQ);
  }

  /**
   * Delete FAQ item
   */
  async deleteFAQ(id: string): Promise<boolean> {
    const deleted = this.faqItems.delete(id);
    if (deleted) {
      this.logger.log(`FAQ deleted: ${id}`);
    } else {
      this.logger.warn(`FAQ not found: ${id}`);
    }
    return deleted;
  }

  /**
   * Convert FAQ to response format
   */
  private toResponse(faq: FAQItem): FAQItemResponse {
    return {
      id: faq.id,
      question: faq.question,
      answer: faq.answer,
      category: faq.category,
      keywords: faq.keywords,
      priority: faq.priority,
      isActive: faq.isActive,
      createdAt: faq.createdAt,
      updatedAt: faq.updatedAt,
    };
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
  }
}