import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import Stripe from "stripe";
import { AppointmentStatus, PaymentStatus } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";

/** How long an unpaid deposit holds the slot (Stripe's minimum session life is 30 min). */
export const DEPOSIT_HOLD_MS = 31 * 60 * 1000;

/** The deposit a service asks for, in cents; 0 when it asks for none. */
export function depositCents(service: {
  depositRequired?: boolean | null;
  depositAmount?: unknown;
  depositPercentage?: unknown;
  price?: unknown;
}): number {
  if (!service.depositRequired) return 0;
  const fixed = Number(service.depositAmount ?? 0);
  if (fixed > 0) return Math.round(fixed * 100);
  const pct = Number(service.depositPercentage ?? 0);
  const price = Number(service.price ?? 0);
  if (pct > 0 && price > 0) return Math.round(price * pct); // pct of euros -> cents
  return 0;
}

export interface DepositCheckout {
  amountCents: number;
  checkoutUrl: string;
  expiresAt: Date;
}

/**
 * Deposits against no-shows, charged on the salon's own Stripe account.
 *
 * The services already had depositRequired / depositAmount / depositPercentage
 * and appointments a depositPaid flag, but nothing charged anything: the
 * deposit was a note. A salon connects its Stripe account through Stripe
 * Connect (account links; KiraRoom never sees its keys). When an online
 * booking is for a service with a deposit, the appointment is held as
 * pending and the client pays on Stripe Checkout -- a direct charge on the
 * salon's account, with no KiraRoom fee. Paid: confirmed and notified.
 * Not paid within 30 minutes: the slot is released.
 */
@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const key = this.config.get<string>("STRIPE_SECRET_KEY");
    this.stripe = key && key.startsWith("sk_") ? new Stripe(key, { apiVersion: "2024-12-18.acacia" as any }) : null;
  }

  private requireStripe(): Stripe {
    if (!this.stripe) throw new ServiceUnavailableException("Stripe no está configurado en KiraRoom");
    return this.stripe;
  }

  private frontendUrl(): string {
    return (this.config.get<string>("FRONTEND_URL") || "http://localhost:3000").replace(/\/$/, "");
  }

  // ---- Connecting the salon's account --------------------------------------

  /** A Stripe onboarding link; creates the salon's connected account the first time. */
  async onboardingLink(tenantId: string): Promise<{ url: string }> {
    const stripe = this.requireStripe();
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeConnectAccountId: true, email: true, country: true, name: true },
    });
    if (!tenant) throw new BadRequestException("Salón no encontrado");
    let accountId = tenant.stripeConnectAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "standard",
        country: (tenant.country || "ES").toUpperCase(),
        email: tenant.email || undefined,
        business_profile: { name: tenant.name },
        metadata: { tenantId },
      });
      accountId = account.id;
      await this.prisma.tenant.update({ where: { id: tenantId }, data: { stripeConnectAccountId: accountId } });
    }
    const back = `${this.frontendUrl()}/dashboard/settings/stripe`;
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${back}?connect=refresh`,
      return_url: `${back}?connect=return`,
    });
    return { url: link.url };
  }

  /** Whether the salon's account can take payments, refreshed from Stripe. */
  async status(tenantId: string): Promise<{ connected: boolean; chargesEnabled: boolean; detailsSubmitted: boolean }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeConnectAccountId: true, stripeConnectChargesEnabled: true },
    });
    if (!tenant?.stripeConnectAccountId) return { connected: false, chargesEnabled: false, detailsSubmitted: false };
    if (!this.stripe) {
      return { connected: true, chargesEnabled: tenant.stripeConnectChargesEnabled, detailsSubmitted: false };
    }
    const account = await this.stripe.accounts.retrieve(tenant.stripeConnectAccountId);
    await this.syncAccount(account);
    return {
      connected: true,
      chargesEnabled: !!account.charges_enabled,
      detailsSubmitted: !!account.details_submitted,
    };
  }

  private async syncAccount(account: Stripe.Account): Promise<void> {
    await this.prisma.tenant.updateMany({
      where: { stripeConnectAccountId: account.id },
      data: { stripeConnectChargesEnabled: !!account.charges_enabled },
    });
  }

  // ---- Charging the deposit -------------------------------------------------

  /**
   * Called right after an online booking is inserted. Returns the checkout to
   * send the client to, or null when no deposit applies (the service asks
   * for none, or the salon has no connected account that can charge).
   */
  async startDeposit(appointmentId: string, returnPath?: string): Promise<DepositCheckout | null> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        service: true,
        client: { select: { email: true } },
        tenant: { select: { stripeConnectAccountId: true, stripeConnectChargesEnabled: true, slug: true, name: true } },
      },
    });
    if (!appointment) return null;
    const amountCents = depositCents(appointment.service);
    const tenant = appointment.tenant;
    if (amountCents <= 0 || !tenant.stripeConnectAccountId || !tenant.stripeConnectChargesEnabled || !this.stripe) {
      return null;
    }
    // Without the Connect webhook nothing would ever mark it paid, and the
    // cron would release a slot the client has paid for.
    if (!this.config.get<string>("STRIPE_CONNECT_WEBHOOK_SECRET")) {
      this.logger.warn("STRIPE_CONNECT_WEBHOOK_SECRET is not set: booking without a deposit");
      return null;
    }

    const expiresAt = new Date(Date.now() + DEPOSIT_HOLD_MS);
    const site = `${this.frontendUrl()}${returnPath || `/sites/${tenant.slug}`}`;
    const separator = site.includes("?") ? "&" : "?";
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        locale: "es",
        customer_email: appointment.client?.email || undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: (appointment.currency || "eur").toLowerCase(),
              unit_amount: amountCents,
              product_data: { name: `Señal: ${appointment.service.name}` },
            },
          },
        ],
        expires_at: Math.floor(expiresAt.getTime() / 1000),
        client_reference_id: appointment.id,
        metadata: { kind: "deposit", appointmentId: appointment.id, tenantId: appointment.tenantId },
        payment_intent_data: { metadata: { kind: "deposit", appointmentId: appointment.id } },
        success_url: `${site}${separator}deposit=paid`,
        cancel_url: `${site}${separator}deposit=cancelled`,
      },
      { stripeAccount: tenant.stripeConnectAccountId },
    );

    await this.prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        depositRequired: true,
        depositAmount: amountCents / 100,
        depositCheckoutSessionId: session.id,
        depositExpiresAt: expiresAt,
      },
    });
    return { amountCents, checkoutUrl: session.url!, expiresAt };
  }

  /**
   * A Connect webhook event (sent for the salons' accounts). Returns the id
   * of an appointment whose deposit has just been paid, so the caller can
   * confirm and notify it.
   */
  async handleConnectEvent(event: Stripe.Event): Promise<{ paidAppointmentId?: string }> {
    switch (event.type) {
      case "account.updated":
        await this.syncAccount(event.data.object as Stripe.Account);
        return {};
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.kind !== "deposit" || session.payment_status !== "paid") return {};
        const id = await this.markPaid(session, event.account ?? undefined);
        return id ? { paidAppointmentId: id } : {};
      }
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.kind === "deposit" && session.metadata.appointmentId) {
          await this.release(session.metadata.appointmentId);
        }
        return {};
      }
      default:
        return {};
    }
  }

  private async markPaid(session: Stripe.Checkout.Session, accountId?: string): Promise<string | null> {
    const appointmentId = session.metadata?.appointmentId;
    if (!appointmentId) return null;
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { tenant: { select: { stripeConnectAccountId: true } } },
    });
    // The event must come from the salon the appointment belongs to.
    if (!appointment || (accountId && appointment.tenant.stripeConnectAccountId !== accountId)) return null;
    if (appointment.depositPaid) return null; // Stripe retries: once only.

    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    await this.prisma.$transaction([
      this.prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          depositPaid: true,
          depositPaymentIntentId: paymentIntentId ?? null,
          depositExpiresAt: null,
          // Stripe refuses payment once the session expires, and the slot is
          // only released after that (releaseExpired), so it is still held.
          status: AppointmentStatus.confirmed,
        },
      }),
      this.prisma.payment.create({
        data: {
          tenantId: appointment.tenantId,
          clientId: appointment.clientId,
          appointmentId,
          amount: session.amount_total ?? Math.round(Number(appointment.depositAmount ?? 0) * 100),
          currency: (session.currency || "eur").toUpperCase(),
          type: "deposit",
          status: PaymentStatus.paid,
          method: "card",
          stripePaymentId: paymentIntentId ?? null,
          description: "Señal pagada al reservar online",
        } as any,
      }),
    ]);
    return appointmentId;
  }

  /** Frees the slot of a booking whose deposit was not paid in time. */
  private async release(appointmentId: string): Promise<void> {
    await this.prisma.appointment.updateMany({
      where: { id: appointmentId, depositPaid: false, status: AppointmentStatus.pending },
      data: {
        status: AppointmentStatus.cancelled,
        cancellationReason: "Señal no pagada a tiempo",
        depositExpiresAt: null,
      },
    });
  }

  /** Safety net for expiry events that never arrive. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async releaseExpired(): Promise<number> {
    const expired = await this.prisma.appointment.findMany({
      where: {
        depositPaid: false,
        status: AppointmentStatus.pending,
        depositExpiresAt: { lt: new Date(Date.now() - 5 * 60 * 1000) },
      },
      select: { id: true },
      take: 200,
    });
    for (const a of expired) await this.release(a.id);
    if (expired.length) this.logger.log(`Released ${expired.length} slot(s) whose deposit was not paid`);
    return expired.length;
  }

  /** Verifies a Connect webhook with its own signing secret. */
  constructEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
    const secret = this.config.get<string>("STRIPE_CONNECT_WEBHOOK_SECRET");
    if (!this.stripe || !secret) throw new ServiceUnavailableException("Stripe Connect webhook not configured");
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }
}
