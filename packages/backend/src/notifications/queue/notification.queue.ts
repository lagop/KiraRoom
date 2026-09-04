import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { EmailService, AppointmentEmailData } from '../services/email.service';
import { SmsService, AppointmentSmsData } from '../services/sms.service';

export interface NotificationJobData {
  type: 'email' | 'sms';
  payload: {
    to: string;
    template: string;
    data: Record<string, any>;
  };
  notificationId?: string;
  retryCount?: number;
}

@Injectable()
export class NotificationQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationQueue.name);
  private queue: Queue;
  private worker: Worker;
  private connectionOptions: { host: string; port: number; maxRetriesPerRequest: null };

  constructor(
    private configService: ConfigService,
    private emailService: EmailService,
    private smsService: SmsService,
  ) {}

  onModuleInit() {
    const redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
    const redisPort = this.configService.get<number>('REDIS_PORT', 6379);

    this.connectionOptions = {
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
    };

    this.queue = new Queue('notifications', {
      connection: this.connectionOptions,
    });

    this.worker = new Worker(
      'notifications',
      async (job) => this.processJob(job),
      {
        connection: this.connectionOptions,
        concurrency: 5,
        limiter: {
          max: 100,
          duration: 1000, // 100 jobs per second
        },
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });

    this.logger.log('Notification queue initialized');
  }

  async onModuleDestroy() {
    await this.worker.close();
    await this.queue.close();
  }

  async addEmailJob(data: Omit<NotificationJobData, 'type'>): Promise<Job> {
    return this.queue.add('email', { type: 'email', ...data }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  }

  async addSmsJob(data: Omit<NotificationJobData, 'type'>): Promise<Job> {
    return this.queue.add('sms', { type: 'sms', ...data }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  }

  private async processJob(job: Job): Promise<void> {
    const { type, payload } = job.data as NotificationJobData;

    switch (type) {
      case 'email':
        await this.processEmailJob(payload);
        break;
      case 'sms':
        await this.processSmsJob(payload);
        break;
      default:
        throw new Error(`Unknown job type: ${type}`);
    }
  }

  private async processEmailJob(payload: NotificationJobData['payload']): Promise<void> {
    const { to, template, data } = payload;
    const emailData = data as AppointmentEmailData;
    
    switch (template) {
      case 'appointment_confirmation':
        await this.emailService.sendAppointmentConfirmation({
          clientEmail: to,
          ...emailData,
        } as AppointmentEmailData);
        break;
      case 'appointment_reminder':
        await this.emailService.sendAppointmentReminder(
          emailData,
          (data as any).hoursBefore,
        );
        break;
      case 'appointment_cancellation':
        await this.emailService.sendAppointmentCancellation(
          emailData,
          (data as any).reason,
        );
        break;
      case 'appointment_rescheduled':
        await this.emailService.sendAppointmentRescheduled(
          emailData,
          (data as any).oldDate,
          (data as any).oldTime,
        );
        break;
      default:
        this.logger.warn(`Unknown email template: ${template}`);
    }
  }

  private async processSmsJob(payload: NotificationJobData['payload']): Promise<void> {
    const { to, template, data } = payload;
    const smsData = data as AppointmentSmsData;
    
    switch (template) {
      case 'appointment_confirmation':
        await this.smsService.sendAppointmentConfirmation({
          clientPhone: to,
          ...smsData,
        } as AppointmentSmsData);
        break;
      case 'appointment_reminder':
        await this.smsService.sendAppointmentReminder(
          smsData,
          (data as any).hoursBefore,
        );
        break;
      case 'appointment_cancellation':
        await this.smsService.sendAppointmentCancellation(
          smsData,
          (data as any).reason,
        );
        break;
      case 'appointment_rescheduled':
        await this.smsService.sendAppointmentRescheduled(
          smsData,
          (data as any).oldDate,
          (data as any).oldTime,
        );
        break;
      default:
        this.logger.warn(`Unknown SMS template: ${template}`);
    }
  }

  async getQueueStats() {
    const [waiting, active, completed, failed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
    ]);

    return { waiting, active, completed, failed };
  }
}
