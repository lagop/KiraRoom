import { BadRequestException, Controller, Get, Headers, HttpCode, Logger, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../auth/decorators/public.decorator";
import { Roles, SALON_MANAGERS } from "../../auth/decorators/roles.decorator";
import { AppointmentsService } from "../appointments.service";
import { DepositsService } from "./deposits.service";

/** The salon connects its own Stripe account, to charge deposits. */
@Controller("payments/connect")
export class StripeConnectController {
  constructor(private readonly deposits: DepositsService) {}

  @Post("onboard")
  @Roles(...SALON_MANAGERS)
  onboard(@Req() req: any) {
    return this.deposits.onboardingLink(req.user.tenantId);
  }

  @Get("status")
  @Roles(...SALON_MANAGERS)
  status(@Req() req: any) {
    return this.deposits.status(req.user.tenantId);
  }
}

/**
 * Stripe Connect events: those of the salons' accounts (deposit paid or
 * expired, account enabled). A separate endpoint from /webhooks/stripe,
 * because Stripe signs Connect events with their own secret
 * (STRIPE_CONNECT_WEBHOOK_SECRET).
 */
@Controller("webhooks/stripe")
export class StripeConnectWebhookController {
  private readonly logger = new Logger(StripeConnectWebhookController.name);

  constructor(
    private readonly deposits: DepositsService,
    private readonly appointments: AppointmentsService,
  ) {}

  @Post("connect")
  @Public() // Stripe has no session; the signature authenticates it.
  @HttpCode(200)
  async handle(@Headers("stripe-signature") signature: string, @Req() req: RawBodyRequest<Request>) {
    if (!signature || !req.rawBody) throw new BadRequestException("Missing signature");
    let event;
    try {
      event = this.deposits.constructEvent(req.rawBody, signature);
    } catch (err) {
      if ((err as any)?.status === 503) throw err;
      this.logger.warn(`Connect webhook signature failed: ${(err as Error).message}`);
      throw new BadRequestException("Invalid Stripe signature");
    }
    const { paidAppointmentId } = await this.deposits.handleConnectEvent(event);
    if (paidAppointmentId) {
      // Confirmation email / SMS now that the booking is secured.
      await this.appointments.onDepositPaid(paidAppointmentId).catch((err) =>
        this.logger.error(`Notifications after deposit for ${paidAppointmentId} failed: ${(err as Error).message}`),
      );
    }
    return { received: true };
  }
}
