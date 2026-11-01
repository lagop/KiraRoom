import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Twilio from 'twilio';
import { MessageBundlesService } from '../../message-bundles/message-bundles.service';
import { displayDate } from './email.service';
import { maskPhone, maskPhonesIn } from '../../common/phone';

export interface SmsOptions {
  to: string;
  body: string;
}

export interface AppointmentSmsData {
  clientName: string;
  clientPhone: string;
  serviceName: string;
  professionalName: string;
  date: string;
  time: string;
  salonName: string;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private twilioClient: Twilio.Twilio | null = null;
  private fromNumber: string | null = null;

  constructor(
    private configService: ConfigService,
    private readonly messageBundles: MessageBundlesService,
  ) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
    this.fromNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER');

    // Only initialize Twilio if credentials are valid
    if (accountSid && authToken && accountSid.startsWith('AC')) {
      this.twilioClient = Twilio(accountSid, authToken);
      this.logger.log('Twilio SMS service initialized successfully');
    } else {
      this.logger.warn('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not configured or invalid - SMS sending disabled');
      this.logger.warn('To enable SMS, set TWILIO_ACCOUNT_SID (must start with "AC"), TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER');
    }
  }

  /**
   * Check if SMS service is configured
   */
  isConfigured(): boolean {
    return this.twilioClient !== null && this.fromNumber !== null;
  }

  /**
   * Send raw SMS
   */
  async sendSms(options: SmsOptions): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!this.twilioClient) {
      this.logger.warn('SMS service not configured - skipping SMS send');
      return { success: false, error: 'SMS service not configured' };
    }

    if (!this.fromNumber) {
      this.logger.warn('TWILIO_PHONE_NUMBER not configured - skipping SMS send');
      return { success: false, error: 'From number not configured' };
    }

    const formattedPhone = this.formatPhoneNumber(options.to);

    if (!this.isValidPhoneNumber(formattedPhone)) {
      this.logger.error(`Invalid phone number format: ${maskPhone(options.to)}`);
      return { success: false, error: 'Invalid phone number format' };
    }

    try {
      const message = await this.twilioClient.messages.create({
        body: options.body,
        from: this.fromNumber,
        to: formattedPhone,
      });

      if (message.status === 'failed' || message.status === 'undelivered') {
        const errorMsg = message.errorMessage || `SMS failed with status: ${message.status}`;
        this.logger.error(`Failed to send SMS: ${maskPhonesIn(errorMsg)}`);
        return { success: false, error: errorMsg };
      }

      this.logger.log(`SMS sent successfully: ${message.sid} to ${maskPhone(formattedPhone)}`);
      return { success: true, id: message.sid };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to send SMS: ${maskPhonesIn(errorMessage)}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send appointment confirmation SMS
   */
  async sendAppointmentConfirmation(data: AppointmentSmsData): Promise<{ success: boolean; id?: string; error?: string }> {
    const body = this.generateConfirmationBody(data);

    return this.sendSms({
      to: data.clientPhone,
      body,
    });
  }

  /**
   * Send appointment reminder SMS
   */
  async sendAppointmentReminder(
    data: AppointmentSmsData,
    hoursBefore: number,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const body = this.generateReminderBody(data, hoursBefore);

    return this.sendSms({
      to: data.clientPhone,
      body,
    });
  }

  /**
   * Send appointment cancellation SMS
   */
  async sendAppointmentCancellation(
    data: AppointmentSmsData,
    reason?: string,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const body = this.generateCancellationBody(data, reason);

    return this.sendSms({
      to: data.clientPhone,
      body,
    });
  }

  /**
   * Send appointment rescheduled SMS
   */
  async sendAppointmentRescheduled(
    data: AppointmentSmsData,
    oldDate: string,
    oldTime: string,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const body = this.generateRescheduledBody(data, oldDate, oldTime);

    return this.sendSms({
      to: data.clientPhone,
      body,
    });
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
   * Who the SMS is from, as its first word: the salon. They used to start
   * with "KiraRoom:", a name the client never booked with.
   */
  private signature(data: AppointmentSmsData): string {
    return (data.salonName ?? "").replace(/s+/g, " ").trim().slice(0, 40) || "Tu salón";
  }

  /**
   * Generate confirmation SMS body
   * Keep under 160 characters for single SMS
   */
  private generateConfirmationBody(data: AppointmentSmsData): string {
    const from = this.signature(data);
    const date = displayDate(data.date);
    const message = `${from}: Tu cita está confirmada. ${data.serviceName} con ${data.professionalName} el ${date} a las ${data.time}. ¡Gracias!`;

    // Truncate if too long (preserve key info)
    if (message.length > 160) {
      return `${from}: Cita confirmada. ${data.serviceName} el ${date} a las ${data.time}. ¡Gracias!`;
    }

    return message;
  }

  /**
   * Generate reminder SMS body
   */
  private generateReminderBody(data: AppointmentSmsData, hoursBefore: number): string {
    const from = this.signature(data);
    if (hoursBefore <= 1) {
      // 1 hour reminder - more urgent
      const message = `${from}: Tu cita es en 1 hora (${data.time}). ${data.serviceName} con ${data.professionalName}.`;

      if (message.length > 160) {
        return `${from}: Cita en 1 hora (${data.time}). ${data.serviceName}.`;
      }

      return message;
    } else {
      // 24 hour reminder
      const message = `${from}: Recordatorio - Tu cita mañana a las ${data.time} para ${data.serviceName}. ¡Te esperamos!`;

      if (message.length > 160) {
        return `${from}: Recordatorio - Cita mañana a las ${data.time}. ${data.serviceName}.`;
      }

      return message;
    }
  }

  /**
   * Generate cancellation SMS body
   */
  private generateCancellationBody(data: AppointmentSmsData, reason?: string): string {
    const from = this.signature(data);
    const date = displayDate(data.date);
    const message = reason
      ? `${from}: Tu cita del ${date} ha sido cancelada. Motivo: ${reason}. Para pedir otra cita, contáctanos.`
      : `${from}: Tu cita del ${date} ha sido cancelada. Para pedir otra cita, contáctanos.`;

    if (message.length > 160) {
      return `${from}: Cita del ${date} cancelada. Contáctanos para pedir otra.`;
    }

    return message;
  }

  /**
   * Generate rescheduled SMS body
   */
  private generateRescheduledBody(data: AppointmentSmsData, oldDate: string, oldTime: string): string {
    const from = this.signature(data);
    const date = displayDate(data.date);
    const message = `${from}: Tu cita ha cambiado al ${date} a las ${data.time}. ${data.serviceName} con ${data.professionalName}.`;

    if (message.length > 160) {
      return `${from}: Cita cambiada al ${date} a las ${data.time}. ${data.serviceName}.`;
    }

    return message;
  }

  /**
   * P2A-receptionist-v2 H-3: send a marketing SMS. Charges one
   * message-bundle credit per recipient via MessageBundlesService.
   * Returns false (without sending) when the wallet is empty.
   */
  async sendMarketingSms(
    tenantId: string,
    to: string,
    body: string,
    stripeSubscriptionItemId?: string | null,
  ): Promise<{ sent: boolean; reason?: string }> {
    const decision = await this.messageBundles
      .consumeCredit({
        tenantId,
        channel: 'sms_marketing',
        stripeSubscriptionItemId,
      })
      .catch(() => ({ ok: false, remaining: 0, reason: 'no_addon' as const }));
    if (!decision.ok) {
      this.logger.warn(
        `sms marketing: skipping ${maskPhone(to)} for tenant ${tenantId} (${decision.reason ?? 'no_credits'})`,
      );
      return { sent: false, reason: decision.reason };
    }
    const result = await this.sendSms({ to, body });
    if (!result.success) {
      this.logger.error(
        `sms marketing: sendSms failed for ${maskPhone(to)} (${maskPhonesIn(result.error)})`,
      );
      return { sent: false, reason: result.error };
    }
    return { sent: true };
  }
}
