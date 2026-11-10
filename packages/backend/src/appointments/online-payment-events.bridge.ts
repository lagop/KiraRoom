import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConnectEventsService } from '../payments/services/connect-events.service';
import { AppointmentsService } from './appointments.service';

/**
 * Hands the Checkout events of the salons' connected accounts to the
 * appointments (a paid booking is confirmed, an expired one is released).
 * Registered from this side so the payments module need not know appointments.
 */
@Injectable()
export class OnlinePaymentEventsBridge implements OnModuleInit {
  constructor(
    private readonly connectEvents: ConnectEventsService,
    private readonly appointments: AppointmentsService,
  ) {}

  onModuleInit() {
    this.connectEvents.registerPaymentHandler((event) => this.appointments.handleOnlinePaymentEvent(event));
  }
}
