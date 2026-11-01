import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { formatCountEs } from "@kira/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { PlatformEmailConfigService } from "../platform/platform-email-config.service";
import { PlatformStripeConfigService } from "../platform/platform-stripe-config.service";

/** The Checkout metadata kind of a bono de emails, for the Stripe webhook. */
export const EMAIL_PACK_KIND = "email_pack";

/** Whether a Checkout session is a bono de emails (not a plan). */
export function isEmailPackSession(session: Pick<Stripe.Checkout.Session, "metadata"> | null | undefined): boolean {
  return session?.metadata?.kind === EMAIL_PACK_KIND;
}

type PackDb = Pick<PrismaService, "$transaction" | "emailPackPurchase" | "emailCreditWallet">;

/**
 * Credits a paid bono de emails to the salon's wallet, from the Checkout
 * session Stripe completed. The emails and price are the session's (what the
 * salon paid for), not the console's current ones. Once per session: the
 * purchase row is unique by session id, so a redelivered webhook is a no-op.
 */
export async function creditEmailPackFromCheckout(
  db: PackDb,
  session: Pick<Stripe.Checkout.Session, "id" | "metadata" | "payment_status" | "client_reference_id">,
  now: Date = new Date(),
): Promise<"credited" | "duplicate" | "unpaid" | "invalid"> {
  if (session.payment_status !== "paid") return "unpaid";
  const tenantId = session.metadata?.tenantId || session.client_reference_id || null;
  const emails = Number(session.metadata?.emails);
  const priceCents = Number(session.metadata?.priceCents ?? 0);
  if (!tenantId || !Number.isInteger(emails) || emails <= 0) return "invalid";
  try {
    await db.$transaction([
      db.emailPackPurchase.create({
        data: {
          tenantId,
          emails,
          priceCents: Number.isInteger(priceCents) ? priceCents : 0,
          source: "stripe",
          stripeCheckoutSessionId: session.id,
        },
      }),
      db.emailCreditWallet.upsert({
        where: { tenantId },
        create: { tenantId, creditsRemaining: emails, creditsPurchasedTotal: emails, lastTopupAt: now },
        update: {
          creditsRemaining: { increment: emails },
          creditsPurchasedTotal: { increment: emails },
          lastTopupAt: now,
        },
      }),
    ]);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "duplicate";
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") return "invalid";
    throw err;
  }
  return "credited";
}

/**
 * "Comprar bono de emails": a one-off Stripe Checkout payment on KiraRoom's
 * account for the bono the platform owner priced in the console (Email de
 * la plataforma). Not offered while it has no price. The webhook credits it
 * (creditEmailPackFromCheckout) and paused campaigns go on by themselves.
 */
@Injectable()
export class EmailPacksService {
  private readonly logger = new Logger(EmailPacksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformEmail: PlatformEmailConfigService,
    private readonly platformStripe: PlatformStripeConfigService,
    private readonly config: ConfigService,
  ) {}

  async createCheckout(tenantId: string): Promise<{ url: string }> {
    const pack = this.platformEmail.marketingPack();
    if (!pack) throw new BadRequestException("El bono de emails todavía no está a la venta.");
    const stripe = this.platformStripe.client();
    if (!stripe) {
      throw new ServiceUnavailableException("Los pagos no están configurados todavía. Escríbenos y lo revisamos.");
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, email: true, stripeCustomerId: true },
    });
    if (!tenant) throw new NotFoundException("Salón no encontrado");

    const base = String(this.config.get("FRONTEND_URL") || "http://localhost:3000").replace(/\/+$/, "");
    const metadata = {
      kind: EMAIL_PACK_KIND,
      tenantId,
      emails: String(pack.emails),
      priceCents: String(pack.priceCents),
    };
    // The same VAT handling as the plan checkout (Stripe Tax, behind the
    // platform's switch).
    const tax = this.platformStripe.current().taxEnabled
      ? {
          automatic_tax: { enabled: true },
          tax_id_collection: { enabled: true },
          ...(tenant.stripeCustomerId ? { customer_update: { name: "auto", address: "auto" } } : {}),
        }
      : {};
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ...(tenant.stripeCustomerId
        ? { customer: tenant.stripeCustomerId }
        : { customer_creation: "always", ...(tenant.email ? { customer_email: tenant.email } : {}) }),
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `Bono de ${formatCountEs(pack.emails)} emails de marketing` },
            unit_amount: pack.priceCents,
          },
          quantity: 1,
        },
      ],
      client_reference_id: tenantId,
      metadata,
      payment_intent_data: { metadata },
      success_url: `${base}/dashboard/email-campaigns?bono=ok`,
      cancel_url: `${base}/dashboard/email-campaigns?bono=cancelado`,
      ...(tax as Record<string, unknown>),
    } as Stripe.Checkout.SessionCreateParams);
    if (!session.url) throw new ServiceUnavailableException("Stripe no ha devuelto la página de pago. Inténtalo de nuevo.");
    this.logger.log(`Tenant ${tenantId}: bono de emails checkout ${session.id} (${pack.emails} emails, ${pack.priceCents} cents)`);
    return { url: session.url };
  }
}
