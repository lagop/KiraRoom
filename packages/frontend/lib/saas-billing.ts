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
