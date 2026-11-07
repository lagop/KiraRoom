import { WebhooksController } from "./webhooks.controller";
import {
  recordChargeRefund,
  recordSubscriptionInvoice,
  statusFor,
  subscriptionInvoiceData,
} from "./subscription-invoices";

/**
 * The console's copy of KiraRoom's plan invoices: what is stored from Stripe's
 * notices, and that a late or repeated notice never breaks it.
 */
function fakePrisma() {
  const rows = new Map<string, any>();
  const byId = (id: string) => [...rows.values()].find((r) => r.id === id);
  return {
    rows,
    subscriptionInvoice: {
      findUnique: async ({ where }: any) => rows.get(where.stripeInvoiceId) ?? null,
      findMany: async ({ where }: any) => [...rows.values()].filter((r) => r.stripeChargeId === where.stripeChargeId),
      upsert: async ({ where, create, update }: any) => {
        const existing = rows.get(where.stripeInvoiceId);
        if (existing) Object.assign(existing, update);
        else rows.set(where.stripeInvoiceId, { id: `row-${rows.size + 1}`, ...create });
      },
      updateMany: async ({ where, data }: any) => {
        const row = byId(where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  } as any;
}

const invoice = (over: Record<string, unknown> = {}) =>
  ({
    id: "in_1",
    customer: "cus_1",
    number: "ABC-0001",
    currency: "eur",
    livemode: true,
    amount_due: 4900,
    amount_paid: 4900,
    created: 1_793_000_000,
    period_start: 1_793_000_000,
    period_end: 1_795_600_000,
    attempt_count: 1,
    status_transitions: { paid_at: 1_793_000_100 },
    hosted_invoice_url: "https://invoice.stripe.com/i/x",
    invoice_pdf: "https://pay.stripe.com/invoice/x/pdf",
    charge: "ch_1",
    lines: { data: [{ description: "KiraRoom Pro" }] },
    ...over,
  }) as any;

const tenant = { id: "t1", name: "Salón Ana" };

describe("statusFor", () => {
  it("is paid, partially refunded or refunded by the amounts; a failure stays failed", () => {
    expect(statusFor("paid", 4900, 0)).toBe("paid");
    expect(statusFor("paid", 4900, 1000)).toBe("partially_refunded");
    expect(statusFor("paid", 4900, 4900)).toBe("refunded");
    expect(statusFor("failed", 0, 0)).toBe("failed");
  });
});

describe("subscriptionInvoiceData", () => {
  it("keeps what the console shows, in cents, with the salon's name and Stripe's links", () => {
    const d = subscriptionInvoiceData(invoice(), "paid", tenant);
    expect(d).toMatchObject({
      stripeInvoiceId: "in_1",
      tenantId: "t1",
      tenantName: "Salón Ana",
      stripeCustomerId: "cus_1",
      stripeChargeId: "ch_1",
      livemode: true,
      status: "paid",
      currency: "EUR",
      amountDueCents: 4900,
      amountPaidCents: 4900,
      description: "KiraRoom Pro",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/x",
    });
    expect(d.paidAt).toEqual(new Date(1_793_000_100 * 1000));
    expect(d.failedAt).toBeNull();
  });

  it("an invoice of an unknown customer is kept without a salon", () => {
    const d = subscriptionInvoiceData(invoice(), "paid", null);
    expect(d.tenantId).toBeNull();
    expect(d.tenantName).toBe("Salón desconocido");
  });
});

describe("recordSubscriptionInvoice", () => {
  it("a paid invoice replaces an earlier failure of the same invoice", async () => {
    const prisma = fakePrisma();
    await recordSubscriptionInvoice(prisma, invoice({ amount_paid: 0 }), "failed", tenant);
    expect(prisma.rows.get("in_1").status).toBe("failed");
    await recordSubscriptionInvoice(prisma, invoice(), "paid", tenant);
    expect(prisma.rows.get("in_1")).toMatchObject({ status: "paid", amountPaidCents: 4900 });
    expect(prisma.rows.size).toBe(1);
  });

  it("a failure that arrives late never undoes a payment", async () => {
    const prisma = fakePrisma();
    await recordSubscriptionInvoice(prisma, invoice(), "paid", tenant);
    await recordSubscriptionInvoice(prisma, invoice({ amount_paid: 0 }), "failed", tenant);
    expect(prisma.rows.get("in_1").status).toBe("paid");
  });

  it("the same notice twice leaves one row", async () => {
    const prisma = fakePrisma();
    await recordSubscriptionInvoice(prisma, invoice(), "paid", tenant);
    await recordSubscriptionInvoice(prisma, invoice(), "paid", tenant);
    expect(prisma.rows.size).toBe(1);
  });

  it("a refund already noted survives a repeated paid notice", async () => {
    const prisma = fakePrisma();
    await recordSubscriptionInvoice(prisma, invoice(), "paid", tenant);
    expect(await recordChargeRefund(prisma, { id: "ch_1", amount_refunded: 1000 })).toBe(1);
    await recordSubscriptionInvoice(prisma, invoice(), "paid", tenant);
    expect(prisma.rows.get("in_1")).toMatchObject({ amountRefundedCents: 1000, status: "partially_refunded" });
  });
});

describe("recordChargeRefund", () => {
  it("marks a full refund, and ignores a charge that paid no invoice of ours", async () => {
    const prisma = fakePrisma();
    await recordSubscriptionInvoice(prisma, invoice(), "paid", tenant);
    expect(await recordChargeRefund(prisma, { id: "ch_1", amount_refunded: 4900 })).toBe(1);
    expect(prisma.rows.get("in_1").status).toBe("refunded");
    expect(await recordChargeRefund(prisma, { id: "ch_other", amount_refunded: 500 })).toBe(0);
  });
});

describe("the webhook keeps the copy", () => {
  function controller(prisma: any) {
    const c = Object.create(WebhooksController.prototype) as any;
    c.logger = { log: () => {}, warn: () => {}, error: jest.fn() };
    c.prisma = prisma;
    c.messageBundles = { creditTopUp: jest.fn() };
    c.email = { sendPaymentFailed: jest.fn() };
    c.configService = { get: () => "https://app.kiraroom.net" };
    return c;
  }

  it("invoice.paid and invoice.payment_failed write the copy, and a failing copy never stops the event", async () => {
    const prisma = fakePrisma();
    prisma.tenant = {
      findFirst: async () => ({ id: "t1", name: "Salón Ana", subscriptionStatus: "active", paymentFailedAt: null }),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    };
    prisma.user = { findFirst: async () => ({ email: "ana@example.test", firstName: "Ana" }) };
    const c = controller(prisma);
    await c.handleInvoicePaid(invoice());
    expect(prisma.rows.get("in_1")).toMatchObject({ status: "paid", tenantId: "t1" });

    await c.handleInvoicePaymentFailed(invoice({ id: "in_2", amount_paid: 0, charge: null }));
    expect(prisma.rows.get("in_2")).toMatchObject({ status: "failed", amountPaidCents: 0 });

    // The copy breaking must not break the event.
    prisma.subscriptionInvoice.findUnique = async () => {
      throw new Error("db down");
    };
    await expect(c.handleInvoicePaid(invoice({ id: "in_3" }))).resolves.toBeUndefined();
    expect(c.logger.error).toHaveBeenCalled();
  });

  it("an invoice of an unknown customer is still kept", async () => {
    const prisma = fakePrisma();
    prisma.tenant = { findFirst: async () => null };
    const c = controller(prisma);
    await c.handleInvoicePaid(invoice({ id: "in_9", customer: "cus_unknown" }));
    expect(prisma.rows.get("in_9")).toMatchObject({ tenantId: null, tenantName: "Salón desconocido" });
  });
});
