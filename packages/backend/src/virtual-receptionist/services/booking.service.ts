import { Injectable, Logger } from '@nestjs/common';
import { BookingRequest, BookingResponse, BookingContext } from '@kira/shared';
import { ProfessionalsService } from '../../professionals/professionals.service';

export enum BookingStage {
  INITIAL = 'initial',
  SERVICE_TYPE = 'service_type',
  PROFESSIONAL = 'professional',
  DATE = 'date',
  TIME = 'time',
  PERSONAL_INFO = 'personal_info',
  CONFIRMATION = 'confirmation',
  COMPLETED = 'completed'
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);
  private bookingContexts: Map<string, BookingContext> = new Map();

  constructor(private readonly professionalsService: ProfessionalsService) {}

  /**
   * Process booking request
   */
  async processBooking(request: BookingRequest): Promise<BookingResponse> {
    this.logger.log(`Processing booking request from ${request.clientInfo.name}`);

    try {
      // In a real implementation, this would:
      // 1. Check service availability
      // 2. Create appointment record in database
      // 3. Send confirmation notification
      // 4. Return booking details

      const availability = await this.checkAvailability(request);
      
      if (!availability.available) {
        return {
          success: false,
          message: availability.message || 'No hay disponibilidad para la fecha y hora solicitadas.',
        };
      }

      // Mock booking creation
      const bookingId = this.generateId();
      
      this.logger.log(`Booking confirmed: ${bookingId}`);

      return {
        success: true,
        appointmentId: bookingId,
        message: '¡Cita reservada con éxito!',
        confirmationUrl: `/confirmacion/${bookingId}`,
        nextStep: BookingStage.COMPLETED,
      };
    } catch (error) {
      this.logger.error('Error processing booking:', error);
      return {
        success: false,
        message: 'Ocurrió un error al procesar tu solicitud. Por favor, inténtalo de nuevo.',
      };
    }
  }

  /**
   * Check availability for a specific time slot
   */
  async checkAvailability(request: any): Promise<{ available: boolean; message?: string; alternatives?: any[] }> {
    this.logger.log(`Checking availability for ${request.date} at ${request.time}`);

    // In a real implementation, this would query the database
    // to check for existing appointments for the given time slot

    // Mock availability check
    const isAvailable = Math.random() > 0.2; // 80% availability

    if (!isAvailable) {
      return {
        available: false,
        message: 'Lo sentimos, el horario solicitado no está disponible.',
        alternatives: [
          { date: request.date, time: this.getNextAvailableTime(request.time) },
          { date: this.getNextAvailableDate(request.date), time: request.time },
        ],
      };
    }

    return { available: true };
  }

  /**
   * Create booking context for a client
   */
  async createBookingContext(context: Omit<BookingContext, 'id' | 'createdAt' | 'updatedAt'>): Promise<BookingContext> {
    const newContext: BookingContext = {
      ...context,
      id: this.generateId(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.bookingContexts.set(newContext.id, newContext);
    this.logger.log(`Booking context created: ${newContext.id}`);
    
    return newContext;
  }

  /**
   * Get booking context for a client
   */
  async getBookingContext(clientId: string): Promise<BookingContext | null> {
    const contexts = Array.from(this.bookingContexts.values())
      .filter(c => c.clientId === clientId && 
                  Date.now() - new Date(c.updatedAt).getTime() < 60 * 60 * 1000); // 1 hour window
    
    if (contexts.length > 0) {
      return contexts.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    }
    
    return null;
  }

  /**
   * Update booking context
   */
  async updateBookingContext(context: Partial<BookingContext>): Promise<BookingContext | null> {
    const existingContext = context.id ? this.bookingContexts.get(context.id) : null;
    
    if (!existingContext) {
      this.logger.warn(`Booking context not found: ${context.id}`);
      return null;
    }

    const updatedContext = {
      ...existingContext,
      ...context,
      updatedAt: new Date(),
    };

    this.bookingContexts.set(updatedContext.id, updatedContext);
    this.logger.log(`Booking context updated: ${updatedContext.id}`);
    
    return updatedContext;
  }

  /**
   * Continue booking process from existing context
   */
  async continueBookingProcess(context: BookingContext, analysis: any): Promise<string> {
    this.logger.log(`Continuing booking process for client ${context.clientId}`);

    switch (context.stage) {
      case BookingStage.INITIAL:
        return '¿Qué servicio te gustaría reservar? Ofrecemos servicios de belleza, spa, y masajes.';
      
      case BookingStage.SERVICE_TYPE:
        const serviceType = analysis.entities.find((e: any) => e.type === 'service_type');
        if (serviceType) {
          await this.updateBookingContext({
            ...context,
            serviceType: serviceType.value,
            stage: BookingStage.PROFESSIONAL,
          });
          return '¿Con qué profesional te gustaría reservar?';
        }
        return 'Lo siento, no pude entender el tipo de servicio. Por favor, especifica el servicio que quieres reservar.';
      
      case BookingStage.PROFESSIONAL:
        const professional = analysis.entities.find((e: any) => e.type === 'professional');
        if (professional) {
          await this.updateBookingContext({
            ...context,
            professional: professional.value,
            stage: BookingStage.DATE,
          });
          return '¿Qué fecha te convendría para tu cita?';
        }
        return 'Lo siento, no pude entender el nombre del profesional. Por favor, especifica el profesional con el que quieres reservar.';
      
      case BookingStage.DATE:
        const date = analysis.entities.find((e: any) => e.type === 'date');
        if (date) {
          await this.updateBookingContext({
            ...context,
            preferredDate: date.value,
            stage: BookingStage.TIME,
          });
          return '¿Qué hora te gustaría para tu cita?';
        }
        return 'Lo siento, no pude entender la fecha. Por favor, especifica una fecha válida.';
      
      case BookingStage.TIME:
        const time = analysis.entities.find((e: any) => e.type === 'time');
        if (time) {
          await this.updateBookingContext({
            ...context,
            preferredTime: time.value,
            stage: BookingStage.PERSONAL_INFO,
          });
          return '¿Podrías proporcionar tu nombre y número de teléfono?';
        }
        return 'Lo siento, no pude entender la hora. Por favor, especifica una hora válida.';
      
      case BookingStage.PERSONAL_INFO:
        const name = analysis.entities.find((e: any) => e.type === 'name');
        const phone = analysis.entities.find((e: any) => e.type === 'phone');
        const email = analysis.entities.find((e: any) => e.type === 'email');

        if (name && phone) {
          await this.updateBookingContext({
            ...context,
            name: name.value,
            phoneNumber: phone.value,
            email: email?.value,
            stage: BookingStage.CONFIRMATION,
          });
          return this.confirmBooking(context);
        }
        return 'Lo siento, no pude obtener tu información personal. Por favor, proporciona tu nombre y número de teléfono.';
      
      case BookingStage.CONFIRMATION:
        if (analysis.requiresHandoff || 
            analysis.sentiment === 'negative' || 
            this.containsNegativeKeywords(analysis)) {
          return 'Lo siento por la confusión. Por favor, contacta directamente al salón para resolver tu solicitud.';
        }
        return this.confirmBooking(context);
      
      default:
        return 'Lo siento, no pude entender tu solicitud. Por favor, contacta directamente al salón.';
    }
  }

  /**
   * Confirm booking and send confirmation
   */
  private confirmBooking(context: BookingContext): string {
    // In a real implementation, this would send a confirmation notification
    this.logger.log(`Booking confirmed: ${context.id}`);

    let confirmationMessage = `¡Tu cita ha sido reservada!
Servicio: ${context.serviceType}`;
    
    if (context.professional) {
      confirmationMessage += `
Profesional: ${context.professional}`;
    }
    
    confirmationMessage += `
Fecha: ${context.preferredDate}
Hora: ${context.preferredTime}
Nombre: ${context.name}
Teléfono: ${context.phoneNumber}

¿Deseas confirmar tu cita?`;

    return confirmationMessage;
  }

  /**
   * Check if message contains negative keywords indicating user wants to cancel
   */
  private containsNegativeKeywords(analysis: any): boolean {
    const negativeKeywords = [
      'cancelar', 'eliminar', 'no', 'no quiero', 'cancelación', 'anular'
    ];
    
    return negativeKeywords.some(keyword => 
      analysis.keywords.some((k: string) => k.toLowerCase().includes(keyword))
    );
  }

  /**
   * Get next available time slot (1 hour later)
   */
  private getNextAvailableTime(time: string): string {
    const [hours, minutes] = time.split(':');
    const nextHours = (parseInt(hours) + 1) % 24;
    return `${String(nextHours).padStart(2, '0')}:${minutes}`;
  }

  /**
   * Get next available date (1 day later)
   */
  private getNextAvailableDate(date: string): string {
    const [day, month, year] = date.split('/');
    const nextDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day) + 1);
    return `${String(nextDate.getDate()).padStart(2, '0')}/${String(nextDate.getMonth() + 1).padStart(2, '0')}/${nextDate.getFullYear()}`;
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Get booking count
   */
  async getBookingCount(): Promise<number> {
    // In a real implementation, this would query the database
    return 0;
  }
}