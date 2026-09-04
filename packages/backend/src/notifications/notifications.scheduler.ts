import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { EmailService } from './services/email.service';
import { SmsService } from './services/sms.service';
import { WhatsAppService } from './services/whatsapp.service';
import { NotificationsService } from './notifications.service';
import { NotificationType } from './dto';

@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly whatsappService: WhatsAppService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * 24-Hour Reminder Cron Job
   * Runs every hour to send reminders for appointments ~24 hours away
   */
  @Cron(CronExpression.EVERY_HOUR)
  async send24HourReminders() {
    this.logger.log('Running 24-hour reminder job...');

    try {
      // Find appointments that are ~24 hours from now
      const now = new Date();
      const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const windowStart = new Date(in24Hours.getTime() - 30 * 60 * 1000); // 30 min window
      const windowEnd = new Date(in24Hours.getTime() + 30 * 60 * 1000);

      const appointments = await this.prisma.appointment.findMany({
        where: {
          startTime: { gte: windowStart, lte: windowEnd },
          status: { in: ['confirmed', 'pending'] },
          reminder24hSent: false,
        },
        include: {
          client: true,
          professional: true,
          service: true,
          tenant: true,
        },
      });

      this.logger.log(`Found ${appointments.length} appointments for 24-hour reminders`);

      let sentCount = 0;
      let errorCount = 0;

      for (const appointment of appointments) {
        try {
          // Check client notification preferences before sending
          const canSendEmail = appointment.clientId && 
            await this.notificationsService.shouldSendNotification(
              appointment.clientId,
              NotificationType.APPOINTMENT_REMINDER_24H,
              'email'
            );
          const canSendSms = appointment.clientId && 
            await this.notificationsService.shouldSendNotification(
              appointment.clientId,
              NotificationType.APPOINTMENT_REMINDER_24H,
              'sms'
            );

          // Create in-app notification
          await this.notificationsService.create({
            tenantId: appointment.tenantId,
            clientId: appointment.clientId,
            type: NotificationType.APPOINTMENT_REMINDER_24H,
            title: 'Recordatorio de cita',
            message: `Tu cita de ${appointment.service.name} es mañana. ¡Te esperamos!`,
            data: {
              appointmentId: appointment.id,
              serviceName: appointment.service.name,
              professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
              scheduledDate: appointment.scheduledDate,
              scheduledTime: appointment.scheduledTime,
            },
          });

          // Send email reminder if client has email and has enabled email notifications
          if (appointment.client.email && canSendEmail) {
            try {
              await this.emailService.sendAppointmentReminder({
                clientName: `${appointment.client.firstName} ${appointment.client.lastName}`,
                clientEmail: appointment.client.email,
                serviceName: appointment.service.name,
                professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
                date: appointment.scheduledDate.toISOString().split('T')[0],
                time: appointment.scheduledTime,
                salonName: appointment.tenant.name,
                salonAddress: this.formatAddress(appointment.tenant),
              }, 24);
            } catch (emailError) {
              this.logger.error(`Failed to send 24h email reminder for appointment ${appointment.id}: ${emailError.message}`);
            }
          } else if (appointment.client.email && !canSendEmail) {
            this.logger.log(`Skipping 24h email reminder for appointment ${appointment.id}: client preferences disabled`);
          }

          // Send SMS reminder if client has phone and has enabled SMS notifications
          if (appointment.client.phone && canSendSms) {
            try {
              await this.smsService.sendAppointmentReminder({
                clientName: appointment.client.firstName,
                clientPhone: appointment.client.phone,
                serviceName: appointment.service.name,
                professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
                date: appointment.scheduledDate.toISOString().split('T')[0],
                time: appointment.scheduledTime,
                salonName: appointment.tenant.name,
              }, 24);
            } catch (smsError) {
              this.logger.error(`Failed to send 24h SMS reminder for appointment ${appointment.id}: ${smsError.message}`);
            }
          } else if (appointment.client.phone && !canSendSms) {
            this.logger.log(`Skipping 24h SMS reminder for appointment ${appointment.id}: client preferences disabled`);
          }

          // Send WhatsApp reminder if client has phone and has enabled WhatsApp notifications
          const canSendWhatsapp = appointment.clientId && 
            await this.notificationsService.shouldSendNotification(
              appointment.clientId,
              NotificationType.APPOINTMENT_REMINDER_24H,
              'whatsapp'
            );
          if (appointment.client.phone && canSendWhatsapp) {
            try {
              await this.whatsappService.sendAppointmentReminder({
                clientName: appointment.client.firstName,
                clientPhone: appointment.client.phone,
                serviceName: appointment.service.name,
                professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
                date: appointment.scheduledDate.toISOString().split('T')[0],
                time: appointment.scheduledTime,
                salonName: appointment.tenant.name,
              }, 24);
            } catch (whatsappError) {
              this.logger.error(`Failed to send 24h WhatsApp reminder for appointment ${appointment.id}: ${whatsappError.message}`);
            }
          } else if (appointment.client.phone && !canSendWhatsapp) {
            this.logger.log(`Skipping 24h WhatsApp reminder for appointment ${appointment.id}: client preferences disabled`);
          }

          // Mark reminder as sent
          await this.prisma.appointment.update({
            where: { id: appointment.id },
            data: { reminder24hSent: true },
          });

          sentCount++;
        } catch (error) {
          this.logger.error(`Failed to send 24-hour reminder for appointment ${appointment.id}: ${error.message}`);
          errorCount++;
        }
      }

      this.logger.log(`24-hour reminder job completed: ${sentCount} sent, ${errorCount} errors`);
    } catch (error) {
      this.logger.error(`24-hour reminder job failed: ${error.message}`);
    }
  }

  /**
   * 1-Hour Reminder Cron Job
   * Runs every 15 minutes to send reminders for appointments ~1 hour away
   */
  @Cron('*/15 * * * *')
  async send1HourReminders() {
    this.logger.log('Running 1-hour reminder job...');

    try {
      // Find appointments that are ~1 hour from now
      const now = new Date();
      const in1Hour = new Date(now.getTime() + 60 * 60 * 1000);
      const windowStart = new Date(in1Hour.getTime() - 15 * 60 * 1000);
      const windowEnd = new Date(in1Hour.getTime() + 15 * 60 * 1000);

      const appointments = await this.prisma.appointment.findMany({
        where: {
          startTime: { gte: windowStart, lte: windowEnd },
          status: { in: ['confirmed', 'pending'] },
          reminder1hSent: false,
        },
        include: {
          client: true,
          professional: true,
          service: true,
          tenant: true,
        },
      });

      this.logger.log(`Found ${appointments.length} appointments for 1-hour reminders`);

      let sentCount = 0;
      let errorCount = 0;

      for (const appointment of appointments) {
        try {
          // Check client notification preferences before sending
          const canSendSms = appointment.clientId && 
            await this.notificationsService.shouldSendNotification(
              appointment.clientId,
              NotificationType.APPOINTMENT_REMINDER_1H,
              'sms'
            );

          // Create in-app notification
          await this.notificationsService.create({
            tenantId: appointment.tenantId,
            clientId: appointment.clientId,
            type: NotificationType.APPOINTMENT_REMINDER_1H,
            title: 'Tu cita es en 1 hora',
            message: `Tu cita de ${appointment.service.name} comienza en 1 hora. ¡Prepárate!`,
            data: {
              appointmentId: appointment.id,
              serviceName: appointment.service.name,
              professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
              scheduledDate: appointment.scheduledDate,
              scheduledTime: appointment.scheduledTime,
            },
          });

          // Send SMS reminder (1-hour reminders are typically SMS only)
          if (appointment.client.phone && canSendSms) {
            try {
              await this.smsService.sendAppointmentReminder({
                clientName: appointment.client.firstName,
                clientPhone: appointment.client.phone,
                serviceName: appointment.service.name,
                professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
                date: appointment.scheduledDate.toISOString().split('T')[0],
                time: appointment.scheduledTime,
                salonName: appointment.tenant.name,
              }, 1);
            } catch (smsError) {
              this.logger.error(`Failed to send 1h SMS reminder for appointment ${appointment.id}: ${smsError.message}`);
            }
          } else if (appointment.client.phone && !canSendSms) {
            this.logger.log(`Skipping 1h SMS reminder for appointment ${appointment.id}: client preferences disabled`);
          }

          // Send WhatsApp reminder if client has phone and has enabled WhatsApp notifications
          const canSendWhatsapp = appointment.clientId && 
            await this.notificationsService.shouldSendNotification(
              appointment.clientId,
              NotificationType.APPOINTMENT_REMINDER_1H,
              'whatsapp'
            );
          if (appointment.client.phone && canSendWhatsapp) {
            try {
              await this.whatsappService.sendAppointmentReminder({
                clientName: appointment.client.firstName,
                clientPhone: appointment.client.phone,
                serviceName: appointment.service.name,
                professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
                date: appointment.scheduledDate.toISOString().split('T')[0],
                time: appointment.scheduledTime,
                salonName: appointment.tenant.name,
              }, 1);
            } catch (whatsappError) {
              this.logger.error(`Failed to send 1h WhatsApp reminder for appointment ${appointment.id}: ${whatsappError.message}`);
            }
          } else if (appointment.client.phone && !canSendWhatsapp) {
            this.logger.log(`Skipping 1h WhatsApp reminder for appointment ${appointment.id}: client preferences disabled`);
          }

          // Mark reminder as sent
          await this.prisma.appointment.update({
            where: { id: appointment.id },
            data: { reminder1hSent: true },
          });

          sentCount++;
        } catch (error) {
          this.logger.error(`Failed to send 1-hour reminder for appointment ${appointment.id}: ${error.message}`);
          errorCount++;
        }
      }

      this.logger.log(`1-hour reminder job completed: ${sentCount} sent, ${errorCount} errors`);
    } catch (error) {
      this.logger.error(`1-hour reminder job failed: ${error.message}`);
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

  /**
   * Review Request Cron Job
   * Runs hourly to send review requests for completed appointments
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendReviewRequests() {
    this.logger.log('Running review request job...');

    try {
      // Find appointments completed in the last 2 hours
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      const appointments = await this.prisma.appointment.findMany({
        where: {
          status: 'completed',
          completionTime: { gte: twoHoursAgo, lt: now },
          reviewRequestSent: false,
        },
        include: {
          client: true,
          service: true,
          professional: true,
          tenant: true,
        },
      });

      this.logger.log(`Found ${appointments.length} completed appointments for review requests`);

      let sentCount = 0;
      let errorCount = 0;

      for (const appointment of appointments) {
        try {
          // Only send review request if client has email
          if (!appointment.client.email) {
            this.logger.debug(`Skipping review request for appointment ${appointment.id}: client has no email`);
            continue;
          }

          // Create in-app notification
          await this.notificationsService.create({
            tenantId: appointment.tenantId,
            clientId: appointment.clientId,
            type: NotificationType.REVIEW_REQUEST,
            title: '¿Cómo fue tu experiencia?',
            message: `Cuéntanos cómo fue tu cita de ${appointment.service.name}. Tu opinión nos importa.`,
            data: {
              appointmentId: appointment.id,
              serviceName: appointment.service.name,
              professionalId: appointment.professionalId,
              professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
            },
          });

          // Send email review request
          try {
            await this.emailService.sendReviewRequest({
              to: appointment.client.email,
              clientName: `${appointment.client.firstName} ${appointment.client.lastName}`,
              serviceName: appointment.service.name,
              professionalName: `${appointment.professional.firstName} ${appointment.professional.lastName}`,
              salonName: appointment.tenant.name,
              appointmentId: appointment.id,
            });
          } catch (emailError) {
            this.logger.error(`Failed to send review request email for appointment ${appointment.id}: ${emailError.message}`);
          }

          // Mark review request as sent
          await this.prisma.appointment.update({
            where: { id: appointment.id },
            data: { reviewRequestSent: true },
          });

          sentCount++;
        } catch (error) {
          this.logger.error(`Failed to send review request for appointment ${appointment.id}: ${error.message}`);
          errorCount++;
        }
      }

      this.logger.log(`Review request job completed: ${sentCount} sent, ${errorCount} errors`);
    } catch (error) {
      this.logger.error(`Review request job failed: ${error.message}`);
    }
  }

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
