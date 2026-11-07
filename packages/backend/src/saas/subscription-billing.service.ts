import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type Stripe from "stripe";
import { PrismaService } from "../common/prisma/prisma.service";
import { PlatformStripeConfigService } from "../platform/platform-stripe-config.service";
import { recordSubscriptionInvoice } from "../payments/subscription-invoices";
import { AuditLogService } from "./audit-log.service";
import { consoleMonths } from "./platform-metrics";
import {
  BILLING_STATUSES,
  livemodeFilter,
  parseBillingMode,
  summarizeInvoices,
  type BillingMode,
} from "./subscription-billing";

export interface InvoiceListQuery {
  tenantId?: string;
  status?: string;
  /** YYYY-MM on the Madrid calendar. */
  month?: string;
  mode?: string;
  page?: number;
  limit?: number;
}

const LIST_SELECT = {
  id: true,
  stripeInvoiceId: true,
  tenantId: true,
  tenantName: true,
  livemode: true,
  status: true,
  number: true,
  currency: true,
  amountDueCents: true,
  amountPaidCents: true,
  amountRefundedCents: true,
  description: true,
  periodStart: true,
  periodEnd: true,
  invoiceCreatedAt: true,
  paidAt: true,
  failedAt: true,
  hostedInvoiceUrl: true,
  invoicePdfUrl: true,
} as const;

/** How many of Stripe's latest invoices a manual sync reads. */
const SYNC_LIMIT = 100;

@Injectable()
export class SubscriptionBillingService {
  private readonly logger = new Logger(SubscriptionBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: PlatformStripeConfigService,
    private readonly auditLog: AuditLogService,
  ) {}

  private platformMode(): "live" | "test" | "none" {
    return (this.stripe.mode?.() as "live" | "test" | "none") ?? "none";
  }

  private mode(raw: string | undefined): BillingMode {
    return parseBillingMode(raw, this.platformMode());
  }

  /** The invoices, newest first. A month, a status and one salon can narrow them. */
  async list(q: InvoiceListQuery) {
    const mode = this.mode(q.mode);
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    if (q.status && !(BILLING_STATUSES as readonly string[]).includes(q.status)) {
      throw new BadRequestException("status must be paid, failed, refunded or partially_refunded");
    }
    const where: Record<string, unknown> = { ...livemodeFilter(mode) };
    if (q.tenantId) where.tenantId = q.tenantId;
    if (q.status) where.status = q.status;
    if (q.month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) throw new BadRequestException("month must be YYYY-MM");
      const m = consoleMonths(24).find((x) => x.month === q.month);
      if (!m) throw new BadRequestException("month must be within the last 24 months");
      where.invoiceCreatedAt = { gte: m.start, lt: m.end };
    }
    const [items, total] = await Promise.all([
      this.prisma.subscriptionInvoice.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [{ invoiceCreatedAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.subscriptionInvoice.count({ where }),
    ]);
    return { mode, items, total, page, limit };
  }

  /** Takings, refunds and failures per month for the last `months` months. */
  async summary(rawMode: string | undefined, months: number) {
    const mode = this.mode(rawMode);
    const window = consoleMonths(months);
    const from = window[0].start;
    const to = window[window.length - 1].end;
    const rows = await this.prisma.subscriptionInvoice.findMany({
      where: {
        ...livemodeFilter(mode),
        OR: [
          { paidAt: { gte: from, lt: to } },
          { failedAt: { gte: from, lt: to } },
          { invoiceCreatedAt: { gte: from, lt: to } },
        ],
      },
      select: {
        status: true,
        amountDueCents: true,
        amountPaidCents: true,
        amountRefundedCents: true,
        paidAt: true,
        failedAt: true,
        invoiceCreatedAt: true,
      },
    });
    const byMonth = summarizeInvoices(rows, window);
    const totals = byMonth.reduce(
      (t, m) => ({
        collectedCents: t.collectedCents + m.collectedCents,
        refundedCents: t.refundedCents + m.refundedCents,
        netCents: t.netCents + m.netCents,
        failedCount: t.failedCount + m.failedCount,
      }),
      { collectedCents: 0, refundedCents: 0, netCents: 0, failedCount: 0 },
    );
    return { mode, currency: "EUR", months: [...byMonth].reverse(), totals };
  }

  /**
   * Fills the copy from Stripe's latest invoices: the gaps if a notice was
   * missed, or the first load. Only invoices of the mode the platform keys
   * are in; paid ones and ones whose payment already failed. Idempotent.
   */
  async sync(actor: { id: string; role: string }) {
    const client = this.stripe.client();
    const mode = this.platformMode();
    if (!client || mode === "none") {
      throw new BadRequestException("Stripe no está configurado: pon las claves en Ajustes → Stripe de la plataforma.");
    }
    const list = await client.invoices.list({ limit: SYNC_LIMIT, expand: ["data.charge"] } as any);
    let recorded = 0;
    let skipped = 0;
    for (const invoice of list.data as Stripe.Invoice[]) {
      const paid = invoice.status === "paid";
      const failed =
        !paid && (invoice.status === "uncollectible" || (invoice.status === "open" && (invoice.attempt_count ?? 0) > 0));
      if ((!paid && !failed) || invoice.livemode !== (mode === "live")) {
        skipped += 1;
        continue;
      }
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      const tenant = customerId
        ? await this.prisma.tenant.findFirst({ where: { stripeCustomerId: customerId }, select: { id: true, name: true } })
        : null;
      const charge = (invoice as any).charge;
      const refunded = typeof charge === "object" && charge ? Number(charge.amount_refunded ?? 0) : undefined;
      await recordSubscriptionInvoice(this.prisma as any, invoice, paid ? "paid" : "failed", tenant, refunded);
      recorded += 1;
    }
    await this.auditLog.record("billing.invoices.sync", {
      actorId: actor.id,
      actorRole: actor.role as any,
      metadata: { mode, recorded, skipped },
    });
    this.logger.log(`Billing sync (${mode}): ${recorded} invoices recorded, ${skipped} skipped`);
    return { mode, recorded, skipped, hasMore: list.has_more === true };
  }
}
