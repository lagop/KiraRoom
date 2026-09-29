import { Injectable, Logger } from '@nestjs/common';
import { CreateFAQItem, UpdateFAQItem, FAQItemResponse } from '@kira/shared';
import { FAQItem } from '@kira/shared';

@Injectable()
export class FAQService {
  private readonly logger = new Logger(FAQService.name);
  private faqItems: Map<string, FAQItem> = new Map();

  /**
   * A salon starts with no FAQs.
   *
   * This used to seed eight invented ones under salonId "default", which
   * every salon inherited: opening hours of 9:00-18:00 and Saturday
   * 9:00-14:00, Visa / Mastercard / American Express, "descuentos para
   * clientes recurrentes", a phone number "(555) 123-4567". Once the FAQs
   * reached the system prompt, the receptionist told every salon's clients
   * all of it as fact -- overriding the salon's real hours.
   */
  constructor() {}

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
      .filter(faq => faq.salonId === salonId)
      .filter(faq => faq.isActive);
  }

  /**
   * Create FAQ item
   */
  async createFAQ(salonId: string, data: CreateFAQItem): Promise<FAQItemResponse> {
    const newFAQ: FAQItem = {
      ...data,
      id: this.generateId(),
      // The caller's salon, never "default": a FAQ one salon wrote was
      // served to every salon's clients.
      salonId,
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
  async getFAQs(salonId: string): Promise<FAQItemResponse[]> {
    return this.getFAQsForSalon(salonId).map(this.toResponse.bind(this));
  }

  /**
   * Get FAQ by ID
   */
  async getFAQ(salonId: string, id: string): Promise<FAQItemResponse | null> {
    const faq = this.ownFAQ(salonId, id);
    if (!faq) {
      this.logger.warn(`FAQ not found: ${id}`);
      return null;
    }
    return this.toResponse(faq);
  }

  /**
   * Update FAQ item
   */
  async updateFAQ(salonId: string, id: string, data: UpdateFAQItem): Promise<FAQItemResponse | null> {
    const faq = this.ownFAQ(salonId, id);
    
    if (!faq) {
      this.logger.warn(`FAQ not found: ${id}`);
      return null;
    }

    const updatedFAQ = {
      ...faq,
      ...data,
      id: faq.id,
      salonId: faq.salonId,
      updatedAt: new Date(),
    };

    this.faqItems.set(id, updatedFAQ);
    this.logger.log(`FAQ updated: ${id}`);
    
    return this.toResponse(updatedFAQ);
  }

  /**
   * Delete FAQ item
   */
  async deleteFAQ(salonId: string, id: string): Promise<boolean> {
    const deleted = !!this.ownFAQ(salonId, id) && this.faqItems.delete(id);
    if (deleted) {
      this.logger.log(`FAQ deleted: ${id}`);
    } else {
      this.logger.warn(`FAQ not found: ${id}`);
    }
    return deleted;
  }

  /** The FAQ, if it belongs to this salon. Another salon's id is "not found". */
  private ownFAQ(salonId: string, id: string): FAQItem | undefined {
    const faq = this.faqItems.get(id);
    return faq && faq.salonId === salonId ? faq : undefined;
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