import type { ConsoleMonth } from "./platform-metrics";

/**
 * What the console shows of KiraRoom's own plan billing, worked out from the
 * copy of the invoices (`subscription_invoices`). Pure, so the rules are
 * tested without a database.
 */
export interface BillingInvoiceRow {
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
  amountRefundedCents: number;
  paidAt: Date | null;
  failedAt: Date | null;
  invoiceCreatedAt: Date;
}

export interface MonthTakings {
  /** YYYY-MM on the Madrid calendar. */
  month: string;
  /** What salons paid in the month (invoices paid then), refunds not yet taken off. */
  collectedCents: number;
  /** Refunded, counted in the month of the payment it comes from. */
  refundedCents: number;
  netCents: number;
  paidCount: number;
  /** Invoices whose payment failed in the month and are still unpaid. */
  failedCount: number;
  failedCents: number;
}

const PAID_STATUSES = new Set(["paid", "refunded", "partially_refunded"]);

const inMonth = (d: Date, m: ConsoleMonth) => d >= m.start && d < m.end;

/** Takings per month: paid in the month of its payment, failed in the month it failed. */
export function summarizeInvoices(rows: BillingInvoiceRow[], months: ConsoleMonth[]): MonthTakings[] {
  return months.map((m) => {
    const out: MonthTakings = {
      month: m.month,
      collectedCents: 0,
      refundedCents: 0,
      netCents: 0,
      paidCount: 0,
      failedCount: 0,
      failedCents: 0,
    };
    for (const r of rows) {
      if (PAID_STATUSES.has(r.status)) {
        if (!inMonth(r.paidAt ?? r.invoiceCreatedAt, m)) continue;
        out.collectedCents += r.amountPaidCents;
        out.refundedCents += r.amountRefundedCents;
        out.paidCount += 1;
      } else if (r.status === "failed") {
        if (!inMonth(r.failedAt ?? r.invoiceCreatedAt, m)) continue;
        out.failedCount += 1;
        out.failedCents += r.amountDueCents;
      }
    }
    out.netCents = out.collectedCents - out.refundedCents;
    return out;
  });
}

/** `?mode=`: the Stripe mode to show. Test invoices must never pass for takings. */
export type BillingMode = "live" | "test" | "all";

export function parseBillingMode(raw: string | undefined, platformMode: "live" | "test" | "none"): BillingMode {
  if (raw === "live" || raw === "test" || raw === "all") return raw;
  return platformMode === "live" ? "live" : "test";
}

export const livemodeFilter = (mode: BillingMode): { livemode?: boolean } =>
  mode === "all" ? {} : { livemode: mode === "live" };

export const BILLING_STATUSES = ["paid", "failed", "refunded", "partially_refunded"] as const;
