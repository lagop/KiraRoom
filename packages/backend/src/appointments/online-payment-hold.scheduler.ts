import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MonitoredJob } from '../common/ops-alerts/ops-alert-sink';
import { AppointmentsService } from './appointments.service';
import { OnlineBookingPaymentService } from './online-booking-payment.service';

/**
 * A booking held while its client pays is released if she never does: the
 * slot is free again. Stripe's notice of the expired page normally does it
 * first; this catches what that missed, and a payment whose notice never
 * arrived is confirmed instead (it asks Stripe before deleting anything).
 * Every 5 minutes. Safe on two instances: each release is conditional.
 */
@Injectable()
export class OnlinePaymentHoldScheduler {
  private readonly logger = new Logger(OnlinePaymentHoldScheduler.name);

  constructor(
    private readonly payments: OnlineBookingPaymentService,
    private readonly appointments: AppointmentsService,
  ) {}

  @Cron('*/5 * * * *')
  @MonitoredJob('OnlinePaymentHoldScheduler.run')
  async run(): Promise<{ released: number; completed: number }> {
    try {
      const out = await this.payments.sweep(new Date());
      if (out.released > 0 || out.completed > 0) {
        this.logger.log(`online payment holds: ${out.released} released, ${out.completed} paid and confirmed`);
      }
      return out;
    } catch (err) {
      this.logger.error(`online payment hold sweep failed: ${(err as Error).message}`);
      return { released: 0, completed: 0 };
    }
  }
}
