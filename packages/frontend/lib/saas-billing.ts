import { formatEuros } from "./console-metrics";

/**
 * KiraRoom's own plan billing as the platform console shows it: a copy of the
 * invoices Stripe issued to the salons (backend `subscription_invoices`).
 */
export type BillingMode = "live" | "test" | "all";

export type InvoiceStatus = "paid" | "failed" | "refunded" | "partially_refunded";

export interface BillingInvoice {
  id: string;
  stripeInvoiceId: string;
  tenantId: string | null;
  tenantName: string;
  livemode: boolean;
  status: InvoiceStatus | string;
  number: string | null;
  currency: string;
  amountDueCents: number;
  amountPaidCents: number;
  amountRefundedCents: number;
  description: string | null;
  invoiceCreatedAt: string;
  paidAt: string | null;
  failedAt: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export interface BillingInvoiceList {
  mode: BillingMode;
  items: BillingInvoice[];
  total: number;
  page: number;
  limit: number;
}

export interface MonthTakings {
  month: string;
  collectedCents: number;
  refundedCents: number;
  netCents: number;
  paidCount: number;
  failedCount: number;
  failedCents: number;
}

export interface BillingSummary {
  mode: BillingMode;
  currency: string;
  months: MonthTakings[];
  totals: { collectedCents: number; refundedCents: number; netCents: number; failedCount: number };
}

export const INVOICE_STATUSES: InvoiceStatus[] = ["paid", "failed", "refunded", "partially_refunded"];

/** Translation key of a status; an unknown one is shown as its own text (null). */
export function invoiceStatusKey(status: string | null | undefined): string | null {
  return INVOICE_STATUSES.includes(status as InvoiceStatus) ? `saas.billing.status_${status}` : null;
}

const STATUS_CLASS: Record<InvoiceStatus, string> = {
  paid: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  refunded: "bg-gray-100 text-gray-800",
  partially_refunded: "bg-yellow-100 text-yellow-800",
};

export function invoiceStatusClass(status: string | null | undefined): string {
  return STATUS_CLASS[status as InvoiceStatus] ?? "bg-gray-100 text-gray-800";
}

/** Cents -> "49,00 €". Every KiraRoom plan invoice is in euros. */
export function formatCents(cents: number | null | undefined): string {
  return formatEuros((Number.isFinite(cents as number) ? (cents as number) : 0) / 100);
}

/** The amount an invoice row shows: what was paid, or what is owed while the payment failed. */
export function invoiceAmountCents(inv: Pick<BillingInvoice, "status" | "amountDueCents" | "amountPaidCents">): number {
  return inv.status === "failed" ? inv.amountDueCents : inv.amountPaidCents;
}

/** "2026-11" -> "noviembre de 2026". */
export function monthTitle(month: string): string {
  const [year, m] = month.split("-").map(Number);
  if (!year || !m) return month;
  return new Date(Date.UTC(year, m - 1, 15)).toLocaleDateString("es-ES", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-11" -> "Noviembre de 2026": only the first letter is a capital. */
export function monthLabel(month: string): string {
  const title = monthTitle(month);
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : title;
}

/**
 * What Stripe writes in an invoice line, split so the console can say it in its
 * own language. Anything it does not recognise stays as Stripe wrote it.
 */
export type InvoiceConcept =
  | { kind: "trial"; plan: string }
  | { kind: "charge"; qty: string; plan: string; price: string; interval: "month" | "year" };

export function parseInvoiceConcept(description: string | null | undefined): InvoiceConcept | null {
  if (!description) return null;
  const trial = /^Trial period for (.+)$/.exec(description);
  if (trial) return { kind: "trial", plan: trial[1] };
  const charge = /^(\d+) × (.+) \(at €([\d.,]+) \/ (month|year)\)$/.exec(description);
  if (charge) {
    const amount = Number.parseFloat(charge[3].replace(/,/g, ""));
    if (!Number.isFinite(amount)) return null;
    return {
      kind: "charge",
      qty: charge[1],
      plan: charge[2],
      price: formatCents(Math.round(amount * 100)),
      interval: charge[4] as "month" | "year",
    };
  }
  return null;
}

/** The invoice line in the console's language (t = its translator); unknown lines are shown as they came. */
export function conceptLabel(
  description: string | null | undefined,
  t: (key: string, params?: Record<string, any>) => string,
): string | null {
  const c = parseInvoiceConcept(description);
  if (!c) return description ?? null;
  if (c.kind === "trial") return t("saas.billing.concept_trial", { plan: c.plan });
  return t(c.interval === "year" ? "saas.billing.concept_year" : "saas.billing.concept_month", {
    qty: c.qty,
    plan: c.plan,
    price: c.price,
  });
}

/** Only Stripe's own addresses may be opened from the console. */
export function safeStripeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname.endsWith(".stripe.com") || u.hostname === "stripe.com") ? url : null;
  } catch {
    return null;
  }
}
