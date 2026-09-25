import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../tenancy/tenant.context";

/**
 * Activation-funnel telemetry.
 *
 * The app had none, so nothing about the funnel after signup could be
 * measured: how many tenants finish the wizard, how long until their first
 * booking, where trials die. Four events answer those questions; add more
 * by calling `record` with a new name, no migration needed.
 *
 * Recording never blocks and never throws. A telemetry write must not be
 * able to fail a signup or a booking.
 */
export const PRODUCT_EVENTS = {
  TENANT_SIGNED_UP: "tenant_signed_up",
  ONBOARDING_COMPLETED: "onboarding_completed",
  FIRST_BOOKING_RECEIVED: "first_booking_received",
  TRIAL_EXPIRED: "trial_expired",
  SUBSCRIPTION_STARTED: "subscription_started",
} as const;

export type ProductEventName =
  (typeof PRODUCT_EVENTS)[keyof typeof PRODUCT_EVENTS];

@Injectable()
export class ProductEventsService {
  private readonly logger = new Logger(ProductEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  record(
    name: ProductEventName | string,
    tenantId?: string | null,
    props: Record<string, unknown> = {},
  ): void {
    void runUnscoped(() =>
      this.prisma.productEvent
        .create({
          data: { name, tenantId: tenantId ?? null, props: props as any },
        })
        .catch((err: Error) => {
          this.logger.warn(`product event '${name}' not recorded: ${err.message}`);
        }),
    );
  }

  /**
   * Records the event only if this tenant has never recorded it before.
   * For once-per-tenant milestones such as the first booking.
   */
  async recordOnce(
    name: ProductEventName | string,
    tenantId: string,
    props: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await runUnscoped(async () => {
        const seen = await this.prisma.productEvent.findFirst({
          where: { name, tenantId },
          select: { id: true },
        });
        if (seen) return;
        await this.prisma.productEvent.create({
          data: { name, tenantId, props: props as any },
        });
      });
    } catch (err) {
      this.logger.warn(
        `product event '${name}' not recorded once: ${(err as Error).message}`,
      );
    }
  }
}
