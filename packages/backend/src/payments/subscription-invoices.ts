import type Stripe from "stripe";

/**
 * A copy of KiraRoom's own plan invoices, kept in `subscription_invoices` so
 * the platform console can list a salon's invoices and the monthly takings
 * without asking Stripe on every view. Stripe issues the invoice and stays
 * its source; this is only what it told us (invoice.paid,
 * invoice.payment_failed, charge.refunded) plus a manual sync from the console.
 */
export type InvoiceOutcome = "paid" | "failed";

export type InvoiceStatus = "paid" | "failed" | "refunded" | "partially_refunded";

type PrismaLike = {
  subscriptionInvoice: {
    upsert: (args: any) => Promise<unknown>;
    updateMany: (args: any) => Promise<{ count: number }>;
    findUnique: (args: any) => Promise<any>;
    findMany: (args: any) => Promise<any[]>;
  };
};

const toDate = (seconds: number | null | undefined): Date | null =>
  typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000) : null;

const idOf = (v: string | { id?: string } | null | undefined): string | null =>
  typeof v === "string" ? v : (v?.id ?? null);

/** paid / refunded / partially_refunded from the amounts; a failed one stays failed. */
export function statusFor(outcome: InvoiceOutcome, amountPaidCents: number, amountRefundedCents: number): InvoiceStatus {
  if (outcome === "failed") return "failed";
  if (amountRefundedCents > 0 && amountPaidCents > 0) {
    return amountRefundedCents >= amountPaidCents ? "refunded" : "partially_refunded";
  }
  return "paid";
}

/** What the table stores for one Stripe invoice. Pure, so it is tested without Stripe. */
export function subscriptionInvoiceData(
  invoice: Stripe.Invoice,
  outcome: InvoiceOutcome,
  tenant: { id: string; name: string } | null,
  refundedCents?: number,
) {
  const anyInvoice = invoice as any;
  const paid = invoice.amount_paid ?? 0;
  const refunded = refundedCents ?? 0;
  const line = invoice.lines?.data?.[0];
  return {
    stripeInvoiceId: invoice.id as string,
    tenantId: tenant?.id ?? null,
    tenantName: tenant?.name ?? "Salón desconocido",
    stripeCustomerId: idOf(invoice.customer as any) ?? "",
    stripeChargeId: idOf(anyInvoice.charge),
    livemode: invoice.livemode === true,
    status: statusFor(outcome, paid, refunded),
    number: invoice.number ?? null,
    currency: (invoice.currency || "eur").toUpperCase(),
    amountDueCents: invoice.amount_due ?? 0,
    amountPaidCents: paid,
    description: line?.description ?? null,
    periodStart: toDate(invoice.period_start),
    periodEnd: toDate(invoice.period_end),
    invoiceCreatedAt: toDate(invoice.created) ?? new Date(),
    paidAt: outcome === "paid" ? (toDate(invoice.status_transitions?.paid_at) ?? new Date()) : null,
    failedAt: outcome === "failed" ? new Date() : null,
    attemptCount: typeof invoice.attempt_count === "number" ? invoice.attempt_count : null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
  };
}

/**
 * Records (or updates) the copy of one invoice. A paid invoice replaces an
 * earlier failure of the same invoice; a failure never replaces a paid one
 * (Stripe retries can arrive late). A refund already noted is kept.
 */
export async function recordSubscriptionInvoice(
  prisma: PrismaLike,
  invoice: Stripe.Invoice,
  outcome: InvoiceOutcome,
  tenant: { id: string; name: string } | null,
  refundedCents?: number,
): Promise<void> {
  if (!invoice?.id) return;
  const existing = await prisma.subscriptionInvoice.findUnique({
    where: { stripeInvoiceId: invoice.id },
    select: { status: true, amountRefundedCents: true },
  });
  // A late failure must not undo a payment that already went through.
  if (outcome === "failed" && existing && existing.status !== "failed") return;
  const refunded = refundedCents ?? existing?.amountRefundedCents ?? 0;
  const data = subscriptionInvoiceData(invoice, outcome, tenant, refunded);
  const { stripeInvoiceId, ...rest } = data;
  await prisma.subscriptionInvoice.upsert({
    where: { stripeInvoiceId },
    create: { ...data, amountRefundedCents: refunded },
    update: { ...rest, amountRefundedCents: refunded },
  });
}

/** `charge.refunded`: notes how much of the invoice paid by that charge came back. */
export async function recordChargeRefund(
  prisma: PrismaLike,
  charge: { id: string; amount_refunded: number },
): Promise<number> {
  const refunded = charge.amount_refunded ?? 0;
  const rows = await prisma.subscriptionInvoice.findMany({
    where: { stripeChargeId: charge.id },
    select: { id: true, amountPaidCents: true, status: true },
  });
  let changed = 0;
  for (const row of rows) {
    const status = statusFor(row.status === "failed" ? "failed" : "paid", row.amountPaidCents, refunded);
    const res = await prisma.subscriptionInvoice.updateMany({
      where: { id: row.id },
      data: { amountRefundedCents: refunded, status },
    });
    changed += res.count;
  }
  return changed;
}
