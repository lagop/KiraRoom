import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Twilio from 'twilio';

export interface WhatsAppMessageData {
  clientName: string;
  clientPhone: string;
  serviceName: string;
  professionalName: string;
  date: string;
  time: string;
  salonName: string;
}

export interface WhatsAppSendResult {
  success: boolean;
  id?: string;
  error?: string;
}

export interface WhatsAppInteractiveMessage {
  body: string;
  buttons?: WhatsAppButton[];
  list?: WhatsAppList;
}

export interface WhatsAppButton {
  id: string;
  title: string;
}

export interface WhatsAppList {
  header: string;
  sections: WhatsAppListSection[];
}

export interface WhatsAppListSection {
  title: string;
  rows: WhatsAppListRow[];
}

export interface WhatsAppListRow {
  id: string;
  title: string;
  description?: string;
}

export interface TwilioWhatsAppWebhookEvent {
  SmsSid: string;
  SmsStatus: string;
  MessageStatus: string;
  To: string;
  From: string;
  Body: string;
  NumMedia: string;
  ApiVersion: string;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private twilioClient: Twilio.Twilio | null = null;
  private fromNumber: string | null = null;

  constructor(private configService: ConfigService) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
    // WhatsApp number can be the same as SMS or a dedicated one
    this.fromNumber = this.configService.get<string>('TWILIO_WHATSAPP_NUMBER') || 
                      this.configService.get<string>('TWILIO_PHONE_NUMBER');
    
    // Only initialize Twilio if credentials are valid
    if (accountSid && authToken && accountSid.startsWith('AC')) {
      this.twilioClient = Twilio(accountSid, authToken);
      this.logger.log('WhatsApp service initialized successfully');
    } else {
      this.logger.warn('TWILIO credentials not configured or invalid - WhatsApp sending disabled');
    }
  }

  /**
   * Check if WhatsApp service is configured
   */
  isConfigured(): boolean {
    return this.twilioClient !== null && this.fromNumber !== null;
  }

  /**
   * Send a text message via WhatsApp
   */
  async sendTextMessage(to: string, body: string): Promise<WhatsAppSendResult> {
    if (!this.isConfigured()) {
      this.logger.warn('WhatsApp service not configured');
      return { success: false, error: 'WhatsApp service not configured' };
    }

    const formattedPhone = this.formatPhoneNumber(to);
    
    if (!this.isValidPhoneNumber(formattedPhone)) {
      this.logger.error(`Invalid phone number format: ${to}`);
      return { success: false, error: 'Invalid phone number format' };
    }

    try {
      const message = await this.twilioClient!.messages.create({
        from: `whatsapp:${this.fromNumber}`,
        to: `whatsapp:${formattedPhone}`,
        body,
      });

      if (message.status === 'failed' || message.status === 'undelivered') {
        const errorMsg = message.errorMessage || `WhatsApp message failed with status: ${message.status}`;
        this.logger.error(`Failed to send WhatsApp message: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      this.logger.log(`WhatsApp message sent to ${to}: ${message.sid}`);
      return { success: true, id: message.sid };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to send WhatsApp message: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send an interactive message via WhatsApp
   */
  async sendInteractiveMessage(to: string, message: WhatsAppInteractiveMessage): Promise<WhatsAppSendResult> {
    if (!this.isConfigured()) {
      this.logger.warn('WhatsApp service not configured');
      return { success: false, error: 'WhatsApp service not configured' };
    }

    const formattedPhone = this.formatPhoneNumber(to);
    
    if (!this.isValidPhoneNumber(formattedPhone)) {
      this.logger.error(`Invalid phone number format: ${to}`);
      return { success: false, error: 'Invalid phone number format' };
    }

    // For Twilio WhatsApp, interactive messages are supported via templates
    // This is a simplified implementation; actual interactive messages may require templates
    try {
      let messageOptions: any = {
        from: `whatsapp:${this.fromNumber}`,
        to: `whatsapp:${formattedPhone}`,
        body: message.body,
      };

      // Add interactive elements if available
      if (message.buttons) {
        // Twilio supports quick replies for WhatsApp
        // This is a simplified approach - actual implementation may vary
        messageOptions.body += `\n\n${message.buttons.map(btn => `${btn.id}. ${btn.title}`).join('\n')}`;
      }

      const result = await this.twilioClient!.messages.create(messageOptions);

      if (result.status === 'failed' || result.status === 'undelivered') {
        const errorMsg = result.errorMessage || `WhatsApp message failed with status: ${result.status}`;
        this.logger.error(`Failed to send WhatsApp interactive message: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      this.logger.log(`WhatsApp interactive message sent to ${to}: ${result.sid}`);
      return { success: true, id: result.sid };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to send WhatsApp interactive message: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle incoming WhatsApp messages from Twilio webhook
   */
  async handleIncomingMessage(event: TwilioWhatsAppWebhookEvent): Promise<void> {
    this.logger.log(`Received WhatsApp message from ${event.From}: ${event.Body}`);

    try {
      // Process the incoming message
      // This is a placeholder - implement your message processing logic here
      
      // Example: Echo the message back to the sender
      // await this.sendTextMessage(event.From, `You said: ${event.Body}`);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to handle incoming WhatsApp message: ${errorMessage}`);
    }
  }

  /**
   * Send appointment confirmation via WhatsApp
   */
  async sendAppointmentConfirmation(data: WhatsAppMessageData): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!this.isConfigured()) {
      this.logger.warn('WhatsApp service not configured');
      return { success: false, error: 'WhatsApp service not configured' };
    }

    const formattedPhone = this.formatPhoneNumber(data.clientPhone);
    
    if (!this.isValidPhoneNumber(formattedPhone)) {
      this.logger.error(`Invalid phone number format: ${data.clientPhone}`);
      return { success: false, error: 'Invalid phone number format' };
    }

    try {
      const message = await this.twilioClient!.messages.create({
        from: `whatsapp:${this.fromNumber}`,
        to: `whatsapp:${formattedPhone}`,
        body: this.generateConfirmationBody(data),
      });

      if (message.status === 'failed' || message.status === 'undelivered') {
        const errorMsg = message.errorMessage || `WhatsApp message failed with status: ${message.status}`;
        this.logger.error(`Failed to send WhatsApp confirmation: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      this.logger.log(`WhatsApp confirmation sent to ${data.clientPhone}: ${message.sid}`);
      return { success: true, id: message.sid };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to send WhatsApp confirmation: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send appointment reminder via WhatsApp
   */
  async sendAppointmentReminder(
    data: WhatsAppMessageData,
    hoursBefore: number,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!this.isConfigured()) {
      this.logger.warn('WhatsApp service not configured');
      return { success: false, error: 'WhatsApp service not configured' };
    }

    const formattedPhone = this.formatPhoneNumber(data.clientPhone);
    
    if (!this.isValidPhoneNumber(formattedPhone)) {
      this.logger.error(`Invalid phone number format: ${data.clientPhone}`);
      return { success: false, error: 'Invalid phone number format' };
    }

    try {
      const message = await this.twilioClient!.messages.create({
        from: `whatsapp:${this.fromNumber}`,
        to: `whatsapp:${formattedPhone}`,
        body: this.generateReminderBody(data, hoursBefore),
      });

      if (message.status === 'failed' || message.status === 'undelivered') {
        const errorMsg = message.errorMessage || `WhatsApp message failed with status: ${message.status}`;
        this.logger.error(`Failed to send WhatsApp reminder: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      this.logger.log(`WhatsApp reminder sent to ${data.clientPhone}: ${message.sid}`);
      return { success: true, id: message.sid };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to send WhatsApp reminder: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send appointment cancellation via WhatsApp
   */
  async sendAppointmentCancellation(
    data: WhatsAppMessageData,
    reason?: string,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!this.isConfigured()) {
      this.logger.warn('WhatsApp service not configured');
      return { success: false, error: 'WhatsApp service not configured' };
    }

    const formattedPhone = this.formatPhoneNumber(data.clientPhone);
    
    if (!this.isValidPhoneNumber(formattedPhone)) {
      this.logger.error(`Invalid phone number format: ${data.clientPhone}`);
      return { success: false, error: 'Invalid phone number format' };
    }

    try {
      const message = await this.twilioClient!.messages.create({
        from: `whatsapp:${this.fromNumber}`,
        to: `whatsapp:${formattedPhone}`,
        body: this.generateCancellationBody(data, reason),
      });

      if (message.status === 'failed' || message.status === 'undelivered') {
        const errorMsg = message.errorMessage || `WhatsApp message failed with status: ${message.status}`;
        this.logger.error(`Failed to send WhatsApp cancellation: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      this.logger.log(`WhatsApp cancellation sent to ${data.clientPhone}: ${message.sid}`);
      return { success: true, id: message.sid };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to send WhatsApp cancellation: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send appointment rescheduled via WhatsApp
   */
  async sendAppointmentRescheduled(
    data: WhatsAppMessageData,
    oldDate: string,
    oldTime: string,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!this.isConfigured()) {
      this.logger.warn('WhatsApp service not configured');
      return { success: false, error: 'WhatsApp service not configured' };
    }

    const formattedPhone = this.formatPhoneNumber(data.clientPhone);
    
    if (!this.isValidPhoneNumber(formattedPhone)) {
      this.logger.error(`Invalid phone number format: ${data.clientPhone}`);
      return { success: false, error: 'Invalid phone number format' };
    }

    try {
      const message = await this.twilioClient!.messages.create({
        from: `whatsapp:${this.fromNumber}`,
        to: `whatsapp:${formattedPhone}`,
        body: this.generateRescheduledBody(data, oldDate, oldTime),
      });

      if (message.status === 'failed' || message.status === 'undelivered') {
        const errorMsg = message.errorMessage || `WhatsApp message failed with status: ${message.status}`;
        this.logger.error(`Failed to send WhatsApp rescheduled: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      this.logger.log(`WhatsApp rescheduled sent to ${data.clientPhone}: ${message.sid}`);
      return { success: true, id: message.sid };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to send WhatsApp rescheduled: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Format phone number to E.164 format
   * Handles Spanish phone numbers (+34 prefix) and other formats
   */
  private formatPhoneNumber(phone: string): string {
    // Remove all non-numeric characters except +
    let cleaned = phone.replace(/[^\d+]/g, '');

    // If it already starts with +, assume it's in E.164 format
    if (cleaned.startsWith('+')) {
      return cleaned;
    }

    // If it starts with 00, replace with +
    if (cleaned.startsWith('00')) {
      return '+' + cleaned.substring(2);
    }

    // Spanish phone numbers: if it starts with 6, 7, 8, or 9 and has 9 digits, add +34
    if (/^[6789]\d{8}$/.test(cleaned)) {
      return '+34' + cleaned;
    }

    // If it's a 10+ digit number without prefix, assume it needs +
    if (cleaned.length >= 10) {
      return '+' + cleaned;
    }

    // Return as-is if we can't determine the format
    return cleaned;
  }

  /**
   * Validate phone number format (basic E.164 validation)
   */
  private isValidPhoneNumber(phone: string): boolean {
    // E.164 format: +[country code][number], max 15 digits total
    const e164Regex = /^\+[1-9]\d{1,14}$/;
    return e164Regex.test(phone);
  }

  /**
   * Generate confirmation WhatsApp body
   * WhatsApp supports markdown-like formatting: *bold*, _italic_, ~strikethrough~
   */
  private generateConfirmationBody(data: WhatsAppMessageData): string {
    return `🔔 *Confirmación de Cita*

Hola ${data.clientName},

Tu cita ha sido confirmada:

📅 *Fecha:* ${data.date}
🕐 *Hora:* ${data.time}
💇 *Servicio:* ${data.serviceName}
👤 *Profesional:* ${data.professionalName}

¡Te esperamos!

_${data.salonName}_`;
  }

  /**
   * Generate reminder WhatsApp body
   */
  private generateReminderBody(data: WhatsAppMessageData, hoursBefore: number): string {
    if (hoursBefore <= 1) {
      // 1 hour reminder - more urgent
      return `⏰ *Recordatorio Urgente*

Hola ${data.clientName},

Tu cita es en *1 hora*:

🕐 *Hora:* ${data.time}
💇 *Servicio:* ${data.serviceName}
👤 *Profesional:* ${data.professionalName}

¡Nos vemos pronto!

_${data.salonName}_`;
    } else {
      // 24 hour reminder
      return `📅 *Recordatorio de Cita*

Hola ${data.clientName},

Te recordamos tu cita de *mañana*:

📅 *Fecha:* ${data.date}
🕐 *Hora:* ${data.time}
💇 *Servicio:* ${data.serviceName}
👤 *Profesional:* ${data.professionalName}

¡Te esperamos!

_${data.salonName}_`;
    }
  }

  /**
   * Generate cancellation WhatsApp body
   */
  private generateCancellationBody(data: WhatsAppMessageData, reason?: string): string {
    if (reason) {
      return `❌ *Cita Cancelada*

Hola ${data.clientName},

Tu cita del ${data.date} ha sido cancelada.

*Motivo:* ${reason}

Para reagendar tu cita, contáctanos.

_${data.salonName}_`;
    }

    return `❌ *Cita Cancelada*

Hola ${data.clientName},

Tu cita del ${data.date} ha sido cancelada.

Para reagendar tu cita, contáctanos.

_${data.salonName}_`;
  }

  /**
   * Generate rescheduled WhatsApp body
   */
  private generateRescheduledBody(data: WhatsAppMessageData, oldDate: string, oldTime: string): string {
    return `🔄 *Cita Reprogramada*

Hola ${data.clientName},

Tu cita ha sido movida:

❌ *Anterior:* ${oldDate} a las ${oldTime}
✅ *Nueva:* ${data.date} a las ${data.time}

💇 *Servicio:* ${data.serviceName}
👤 *Profesional:* ${data.professionalName}

¡Te esperamos!

_${data.salonName}_`;
  }
}
