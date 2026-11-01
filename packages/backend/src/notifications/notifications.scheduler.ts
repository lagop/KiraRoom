import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { realEmail } from '../common/placeholder-email';
import { EmailService } from './services/email.service';
import { SmsService } from './services/sms.service';
import { WhatsAppService } from './services/whatsapp.service';
import { NotificationsService } from './notifications.service';
import { NotificationType } from './dto';
import { WhatsAppTemplateService } from '../whatsapp/whatsapp-template.service';
import { withBookedService } from '../appointments/appointment-snapshot';
import { bookingPlace } from '../multi-location/client-locations';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Sends of one reminder that reached no channel are tried this many times in all. */
export const MAX_REMINDER_ATTEMPTS = 3;

/** Appointments taken per tick; the next tick picks up the rest. */
const REMINDER_BATCH_SIZE = 500;

const ACTIVE_STATUSES: AppointmentStatus[] = [AppointmentStatus.pending, AppointmentStatus.confirmed];

/** What one channel did with a reminder: delivered, tried and failed, or not usable. */
export type ChannelOutcome = 'sent' | 'failed' | 'skipped';

interface ReminderKind {
  hoursBefore: 24 | 1;
  type: NotificationType;
  sentField: 'reminder24hSent' | 'reminder1hSent';
  attemptsField: 'reminder24hAttempts' | 'reminder1hAttempts';
  /** Due once the appointment starts within this much of now. */
  lead: number;
  /** Neither sent nor retried when the appointment starts sooner than this. */
  minLead: number;
}

/**
 * Due from 24 h before the start. Below 2 h the 1-hour reminder takes over,
 * so a late catch-up does not send both at once.
 */
export const REMINDER_24H: ReminderKind = {
  hoursBefore: 24,
  type: NotificationType.APPOINTMENT_REMINDER_24H,
  sentField: 'reminder24hSent',
  attemptsField: 'reminder24hAttempts',
  lead: 24 * HOUR,
  minLead: 2 * HOUR,
};

/** The job runs every 15 minutes, so this lands 55 to 70 minutes before. */
export const REMINDER_1H: ReminderKind = {
  hoursBefore: 1,
  type: NotificationType.APPOINTMENT_REMINDER_1H,
  sentField: 'reminder1hSent',
  attemptsField: 'reminder1hAttempts',
  lead: 70 * MINUTE,
  minLead: 10 * MINUTE,
};

const reminderInclude = {
  client: true,
  professional: true,
  service: true,
  tenant: true,
} satisfies Prisma.AppointmentInclude;

type ReminderAppointment = Prisma.AppointmentGetPayload<{ include: typeof reminderInclude }>;

/** Delivered when any channel delivered; failed when none did and one failed. */
function combine(outcomes: ChannelOutcome[]): ChannelOutcome {
  if (outcomes.includes('sent')) return 'sent';
  if (outcomes.includes('failed')) return 'failed';
  return 'skipped';
}

@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly whatsappService: WhatsAppService,
    private readonly notificationsService: NotificationsService,
    private readonly whatsappTemplates: WhatsAppTemplateService,
  ) {}

  /**
   * A WhatsApp reminder. From the salon's own WhatsApp Business number with
   * the approved template when it can (a free-text message a day before the
   * appointment is outside WhatsApp's 24-hour window and is refused); the
   * platform's Twilio sender otherwise, as before.
   */
  private async sendWhatsAppReminder(appointment: any, hoursBefore: number): Promise<ChannelOutcome> {
    const viaSalon = await this.whatsappTemplates.sendAppointmentReminder(appointment.tenantId, {
      phone: appointment.client.phone,
      clientName: appointment.client.firstName,
      salonName: appointment.tenant.name,
      serviceName: appointment.service.name,
      date: appointment.scheduledDate,
      time: appointment.scheduledTime,
      country: appointment.tenant.country ?? undefined,
    });
    if (viaSalon.sent) return 'sent';
    // Not connected, or the template not approved: the salon has no WhatsApp
    // for this. Any other reason is Meta refusing a send that was tried.
    const salonUnavailable = viaSalon.reason === 'not_connected' || !!viaSalon.reason?.startsWith('template_');
    if (viaSalon.reason !== 'not_connected') {
      this.logger.log(`WhatsApp template not used for appointment ${appointment.id}: ${viaSalon.reason}`);
    }
    if (!this.whatsappService.isConfigured()) return salonUnavailable ? 'skipped' : 'failed';
    const result = await this.whatsappService.sendAppointmentReminder({
      clientName: appointment.client.firstName,
      clientPhone: appointment.client.phone,
      serviceName: appointment.service.name,
      professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
      date: appointment.scheduledDate.toISOString().split('T')[0],
      time: appointment.scheduledTime,
      salonName: appointment.tenant.name,
    }, hoursBefore);
    return result?.success ? 'sent' : 'failed';
  }

  /**
   * 24-Hour Reminder Cron Job
   * Runs every hour. Takes every appointment whose reminder is due and not
   * yet sent, not only those exactly 24 h away, so a tick missed during a
   * deploy or restart is caught up on the next one.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async send24HourReminders(now: Date = new Date()) {
    return this.runReminders(REMINDER_24H, now);
  }

  /**
   * 1-Hour Reminder Cron Job
   * Runs every 15 minutes. By SMS or WhatsApp; by email when the salon has
   * neither for this client.
   */
  @Cron('*/15 * * * *')
  async send1HourReminders(now: Date = new Date()) {
    return this.runReminders(REMINDER_1H, now);
  }

  /**
   * Appointments whose reminder is due: starting within `lead` (by the real
   * UTC startTime) but not sooner than `minLead`, still pending or
   * confirmed, not reminded, and with attempts left. One booked after the
   * reminder's moment (e.g. this morning for this afternoon) gets none: the
   * booking confirmation has just told the client.
   */
  async dueReminders(kind: ReminderKind, now: Date): Promise<ReminderAppointment[]> {
    const due = await this.prisma.appointment.findMany({
      where: {
        startTime: {
          gt: new Date(now.getTime() + kind.minLead),
          lte: new Date(now.getTime() + kind.lead),
        },
        status: { in: ACTIVE_STATUSES },
        [kind.sentField]: false,
        [kind.attemptsField]: { lt: MAX_REMINDER_ATTEMPTS },
      },
      include: reminderInclude,
      orderBy: { startTime: 'asc' },
      take: REMINDER_BATCH_SIZE,
    });
    // The service as it was booked (appointment-snapshot.ts): a rename in the
    // catalog does not reach a reminder for an appointment already made.
    return due
      .filter((a) => a.createdAt.getTime() <= a.startTime!.getTime() - kind.lead)
      .map((a) => withBookedService(a));
  }

  private async runReminders(kind: ReminderKind, now: Date) {
    const label = `${kind.hoursBefore}-hour`;
    this.logger.log(`Running ${label} reminder job...`);
    const counts = { sent: 0, failed: 0, skipped: 0 };

    try {
      const appointments = await this.dueReminders(kind, now);
      this.logger.log(`Found ${appointments.length} appointments for ${label} reminders`);

      for (const appointment of appointments) {
        try {
          const outcome = await this.remind(appointment, kind);
          if (outcome) counts[outcome]++;
        } catch (error) {
          this.logger.error(`Failed to process ${label} reminder for appointment ${appointment.id}: ${error.message}`);
          counts.failed++;
        }
      }

      this.logger.log(
        `${label} reminder job completed: ${counts.sent} sent, ${counts.failed} failed, ${counts.skipped} without a channel`,
      );
    } catch (error) {
      this.logger.error(`${label} reminder job failed: ${error.message}`);
    }
    return counts;
  }

  /**
   * Claims the reminder, sends it, and gives it back for a later tick when
   * no channel delivered it.
   *
   * The claim is the review requests' one (ReviewsService.dispatchForTenant):
   * the update that flips the flag wins, so with two backend instances, or a
   * tick that overlaps the previous one, only one sends. It also matches the
   * attempt count and start time it read, so a row released by a failed send,
   * or moved meanwhile, is not taken on a stale read. The flag only stays set
   * when a channel delivered (or none was usable); a failed send clears it
   * again and counts the attempt. Returns null when another run had it.
   */
  async remind(appointment: ReminderAppointment, kind: ReminderKind): Promise<ChannelOutcome | null> {
    const attempts = appointment[kind.attemptsField];
    const claimed = await this.prisma.appointment.updateMany({
      where: {
        id: appointment.id,
        [kind.sentField]: false,
        [kind.attemptsField]: attempts,
        startTime: appointment.startTime,
        status: { in: ACTIVE_STATUSES },
      },
      data: { [kind.sentField]: true },
    });
    if (claimed.count !== 1) return null;

    let outcome: ChannelOutcome;
    try {
      outcome = await this.deliver(appointment, kind, attempts === 0);
    } catch (error) {
      this.logger.error(`Failed to send ${kind.hoursBefore}h reminder for appointment ${appointment.id}: ${error.message}`);
      outcome = 'failed';
    }

    if (outcome === 'failed') {
      await this.prisma.appointment.update({
        where: { id: appointment.id },
        data: { [kind.sentField]: false, [kind.attemptsField]: { increment: 1 } },
      });
      if (attempts + 1 >= MAX_REMINDER_ATTEMPTS) {
        this.logger.warn(
          `${kind.hoursBefore}h reminder for appointment ${appointment.id} failed ${MAX_REMINDER_ATTEMPTS} times: giving up`,
        );
      }
    } else if (outcome === 'skipped') {
      this.logger.log(`No channel for the ${kind.hoursBefore}h reminder of appointment ${appointment.id}`);
    }
    return outcome;
  }

  private async deliver(
    appointment: ReminderAppointment,
    kind: ReminderKind,
    firstAttempt: boolean,
  ): Promise<ChannelOutcome> {
    const professionalName = `${appointment.professional.firstName} ${appointment.professional.lastName}`;

    // In-app, once: a retry is for the external channels.
    if (firstAttempt) {
      await this.notificationsService
        .create({
          tenantId: appointment.tenantId,
          clientId: appointment.clientId,
          type: kind.type,
          ...(kind.hoursBefore === 1
            ? {
                title: 'Tu cita es en 1 hora',
                message: `Tu cita de ${appointment.service.name} comienza en 1 hora. ¡Prepárate!`,
              }
            : {
                title: 'Recordatorio de cita',
                message: `Tu cita de ${appointment.service.name} es mañana. ¡Te esperamos!`,
              }),
          data: {
            appointmentId: appointment.id,
            serviceName: appointment.service.name,
            professionalName,
            scheduledDate: appointment.scheduledDate,
            scheduledTime: appointment.scheduledTime,
          },
        })
        .catch((error) =>
          this.logger.error(`In-app ${kind.hoursBefore}h reminder for appointment ${appointment.id} failed: ${error.message}`),
        );
    }

    const outcomes: ChannelOutcome[] = [];

    // 24 h: by email as well as by phone. 1 h: by phone, email only as the
    // fallback below.
    if (kind.hoursBefore === 24) {
      outcomes.push(await this.emailReminder(appointment, kind));
    }

    if (appointment.client.phone && (await this.allowed(appointment, kind, 'sms'))) {
      outcomes.push(
        this.smsService.isConfigured()
          ? await this.attempt(appointment, kind, 'SMS', async () => {
              const result = await this.smsService.sendAppointmentReminder({
                clientName: appointment.client.firstName,
                clientPhone: appointment.client.phone!,
                serviceName: appointment.service.name,
                professionalName,
                date: appointment.scheduledDate.toISOString().split('T')[0],
                time: appointment.scheduledTime,
                salonName: appointment.tenant.name,
              }, kind.hoursBefore);
              return result?.success ? 'sent' : 'failed';
            })
          : 'skipped',
      );
    }

    if (appointment.client.phone && (await this.allowed(appointment, kind, 'whatsapp'))) {
      outcomes.push(
        await this.attempt(appointment, kind, 'WhatsApp', () => this.sendWhatsAppReminder(appointment, kind.hoursBefore)),
      );
    }

    // Production has neither SMS nor WhatsApp for most salons: the 1-hour
    // reminder then goes by email rather than not at all.
    if (kind.hoursBefore === 1 && !outcomes.some((o) => o !== 'skipped')) {
      outcomes.push(await this.emailReminder(appointment, kind));
    }

    return combine(outcomes);
  }

  private async emailReminder(appointment: ReminderAppointment, kind: ReminderKind): Promise<ChannelOutcome> {
    const email = realEmail(appointment.client.email);
    if (!email || !this.emailService.isConfigured()) return 'skipped';
    if (!(await this.allowed(appointment, kind, 'email'))) return 'skipped';
    return this.attempt(appointment, kind, 'email', async () => {
      // At one of several locations: that one's name and address, not the salon's.
      const place = await bookingPlace(this.prisma as any, appointment.tenantId, appointment.locationId).catch(
        () => null,
      );
      const result = await this.emailService.sendAppointmentReminder({
        clientName: `${appointment.client.firstName} ${appointment.client.lastName}`,
        clientEmail: email,
        serviceName: appointment.service.name,
        professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
        date: appointment.scheduledDate.toISOString().split('T')[0],
        time: appointment.scheduledTime,
        salonName: appointment.tenant.name,
        salonAddress: place?.address || this.formatAddress(appointment.tenant),
        ...(place ? { locationName: place.name } : {}),
      }, kind.hoursBefore, {
        // A retry after a send that timed out but went through is not delivered twice.
        idempotencyKey: `appointment-reminder-${kind.hoursBefore}h-${appointment.id}-${appointment.startTime!.getTime()}`,
      });
      return result?.success ? 'sent' : 'failed';
    });
  }

  /** The client's notification preferences for this reminder and channel. */
  private async allowed(
    appointment: ReminderAppointment,
    kind: ReminderKind,
    channel: 'email' | 'sms' | 'whatsapp',
  ): Promise<boolean> {
    const allowed =
      !!appointment.clientId &&
      (await this.notificationsService.shouldSendNotification(appointment.clientId, kind.type, channel));
    if (!allowed) {
      this.logger.log(`Skipping ${kind.hoursBefore}h ${channel} reminder for appointment ${appointment.id}: client preferences disabled`);
    }
    return allowed;
  }

  private async attempt(
    appointment: ReminderAppointment,
    kind: ReminderKind,
    channel: string,
    send: () => Promise<ChannelOutcome>,
  ): Promise<ChannelOutcome> {
    try {
      const outcome = await send();
      if (outcome === 'failed') {
        this.logger.error(`Failed to send ${kind.hoursBefore}h ${channel} reminder for appointment ${appointment.id}`);
      }
      return outcome;
    } catch (error) {
      this.logger.error(
        `Failed to send ${kind.hoursBefore}h ${channel} reminder for appointment ${appointment.id}: ${error.message}`,
      );
      return 'failed';
    }
  }

  /**
   * Notification Cleanup Cron Job
   * Runs daily at 3 AM to delete old notifications (older than 90 days)
   */
  @Cron('0 3 * * *')
  async cleanupOldNotifications() {
    this.logger.log('Running notification cleanup job...');

    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      // Delete notifications older than 90 days
      const result = await this.prisma.notification.deleteMany({
        where: {
          createdAt: { lt: ninetyDaysAgo },
        },
      });

      this.logger.log(`Deleted ${result.count} old notifications`);
    } catch (error) {
      this.logger.error(`Notification cleanup job failed: ${error.message}`);
    }
  }

  // Review requests are sent by ReviewsService.dispatchReviewRequests. A
  // second job here raced it for the same appointments and sent an English
  // email whose button linked to "#".

  /**
   * Helper method to format tenant address
   */
  private formatAddress(tenant: any): string {
    const parts = [
      tenant.street,
      tenant.city,
      tenant.state,
      tenant.postalCode,
      tenant.country,
    ].filter(Boolean);
    return parts.join(', ');
  }
}
