import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { AppointmentsService, PENDING_BOOKING_MAX_HOURS } from "./appointments.service";

/**
 * Online bookings the salon has not confirmed within 48 hours are cancelled,
 * and the client is told "{Salón} no ha podido confirmar tu cita" (email;
 * SMS only where her booking SMS were allowed), so nobody turns up for an
 * appointment that was never accepted, and the slot is free again
 * (AppointmentsService.expireUnconfirmedOnlineBookings).
 *
 * Hourly, at :35. Safe on two instances: each cancellation is written only
 * over the status it read, so the second run finds nothing to do.
 */
@Injectable()
export class PendingBookingExpiryScheduler {
  private readonly logger = new Logger(PendingBookingExpiryScheduler.name);

  constructor(private readonly appointments: AppointmentsService) {}

  @Cron("35 * * * *")
  async run(): Promise<number> {
    try {
      const expired = await this.appointments.expireUnconfirmedOnlineBookings(new Date(), PENDING_BOOKING_MAX_HOURS);
      if (expired > 0) this.logger.log(`pending bookings: ${expired} not confirmed in ${PENDING_BOOKING_MAX_HOURS} h, cancelled`);
      return expired;
    } catch (err) {
      this.logger.error(`pending booking expiry failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
