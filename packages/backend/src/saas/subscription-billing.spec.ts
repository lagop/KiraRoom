import { BadRequestException } from "@nestjs/common";
import { consoleMonths } from "./platform-metrics";
import { livemodeFilter, parseBillingMode, summarizeInvoices } from "./subscription-billing";
import { SubscriptionBillingService } from "./subscription-billing.service";

const NOW = new Date("2026-11-07T10:00:00.000Z");
const months = consoleMonths(3, NOW); // 2026-09, 2026-10, 2026-11

const row = (over: Record<string, unknown>) => ({
  status: "paid",
  amountDueCents: 4900,
  amountPaidCents: 4900,
  amountRefundedCents: 0,
  paidAt: new Date("2026-10-15T09:00:00.000Z"),
  failedAt: null,
  invoiceCreatedAt: new Date("2026-10-15T09:00:00.000Z"),
  ...over,
});

describe("summarizeInvoices", () => {
  it("counts a payment in the month it was paid, refunds taken off, failures in the month they failed", () => {
    const out = summarizeInvoices(
      [
        row({}),
        row({ status: "partially_refunded", amountRefundedCents: 1000 }),
        row({ status: "failed", amountPaidCents: 0, paidAt: null, failedAt: new Date("2026-11-03T08:00:00.000Z") }),
        row({ paidAt: new Date("2026-09-20T09:00:00.000Z"), invoiceCreatedAt: new Date("2026-09-20T09:00:00.000Z") }),
      ] as any,
      months,
    );
    const by = Object.fromEntries(out.map((m) => [m.month, m]));
    expect(by["2026-10"]).toMatchObject({ collectedCents: 9800, refundedCents: 1000, netCents: 8800, paidCount: 2 });
    expect(by["2026-11"]).toMatchObject({ failedCount: 1, failedCents: 4900, collectedCents: 0 });
    expect(by["2026-09"]).toMatchObject({ collectedCents: 4900, paidCount: 1 });
  });

  it("months are Madrid's: a payment at 23:30 UTC on 31 October belongs to November there", () => {
    const out = summarizeInvoices(
      [row({ paidAt: new Date("2026-10-31T23:30:00.000Z"), invoiceCreatedAt: new Date("2026-10-31T23:30:00.000Z") })] as any,
      months,
    );
    expect(out.find((m) => m.month === "2026-11")?.paidCount).toBe(1);
    expect(out.find((m) => m.month === "2026-10")?.paidCount).toBe(0);
  });
});

describe("the mode", () => {
  it("shows the mode the platform keys are in, unless asked otherwise; test never passes for takings", () => {
    expect(parseBillingMode(undefined, "live")).toBe("live");
    expect(parseBillingMode(undefined, "test")).toBe("test");
    expect(parseBillingMode(undefined, "none")).toBe("test");
    expect(parseBillingMode("all", "live")).toBe("all");
    expect(parseBillingMode("nonsense", "live")).toBe("live");
    expect(livemodeFilter("live")).toEqual({ livemode: true });
    expect(livemodeFilter("test")).toEqual({ livemode: false });
    expect(livemodeFilter("all")).toEqual({});
  });
});

describe("SubscriptionBillingService", () => {
  function service(opts: { rows?: any[]; mode?: string; client?: any } = {}) {
    const findMany = jest.fn(async () => opts.rows ?? []);
    const count = jest.fn(async () => (opts.rows ?? []).length);
    const prisma: any = {
      subscriptionInvoice: { findMany, count, findUnique: async () => null, upsert: jest.fn(async () => ({})), updateMany: async () => ({ count: 0 }) },
      tenant: { findFirst: async () => ({ id: "t1", name: "Salón Ana" }) },
    };
    const stripe: any = { mode: () => opts.mode ?? "test", client: () => opts.client ?? null };
    const audit: any = { record: jest.fn(async () => ({ id: "a1" })) };
    return { svc: new SubscriptionBillingService(prisma, stripe, audit), prisma, findMany, audit };
  }

  it("lists newest first, only the platform's mode by default, and one salon when asked", async () => {
    const { svc, findMany } = service({ mode: "live", rows: [{ id: "1" }] });
    const out = await svc.list({ tenantId: "t1", status: "failed", page: 2, limit: 10 });
    const args = (findMany.mock.calls[0] as any[])[0];
    expect(args.where).toEqual({ livemode: true, tenantId: "t1", status: "failed" });
    expect(args.orderBy[0]).toEqual({ invoiceCreatedAt: "desc" });
    expect(args).toMatchObject({ skip: 10, take: 10 });
    expect(out).toMatchObject({ mode: "live", page: 2, limit: 10 });
  });

  it("refuses an unknown status or a bad month", async () => {
    const { svc } = service();
    await expect(svc.list({ status: "weird" })).rejects.toThrow(BadRequestException);
    await expect(svc.list({ month: "2026-13" })).rejects.toThrow(BadRequestException);
    await expect(svc.list({ month: "2019-01" })).rejects.toThrow(BadRequestException);
  });

  it("the summary lists the latest month first with totals", async () => {
    const { svc } = service({ rows: [row({})] });
    const out = await svc.summary(undefined, 3);
    expect(out.months).toHaveLength(3);
    expect(out.months[0].month > out.months[2].month).toBe(true);
    expect(out.currency).toBe("EUR");
  });

  it("sync needs Stripe keys, reads the mode's paid and failed invoices, and leaves a trace", async () => {
    await expect(service({ mode: "none" }).svc.sync({ id: "u", role: "saas_owner" })).rejects.toThrow(/Stripe no está configurado/);

    const inv = (id: string, status: string, livemode: boolean, attempts = 0) => ({
      id,
      status,
      livemode,
      customer: "cus_1",
      number: id,
      currency: "eur",
      amount_due: 4900,
      amount_paid: status === "paid" ? 4900 : 0,
      created: 1_793_000_000,
      attempt_count: attempts,
      status_transitions: {},
      charge: status === "paid" ? { id: "ch_" + id, amount_refunded: 900 } : null,
      lines: { data: [] },
    });
    const client = {
      invoices: {
        list: jest.fn(async () => ({
          has_more: false,
          data: [inv("in_a", "paid", false), inv("in_b", "open", false, 2), inv("in_c", "draft", false), inv("in_d", "paid", true)],
        })),
      },
    };
    const { svc, prisma, audit } = service({ mode: "test", client });
    const out = await svc.sync({ id: "u", role: "saas_owner" });
    expect(out).toEqual({ mode: "test", recorded: 2, skipped: 2, hasMore: false });
    expect(prisma.subscriptionInvoice.upsert).toHaveBeenCalledTimes(2);
    const first = (prisma.subscriptionInvoice.upsert.mock.calls[0] as any[])[0];
    expect(first.create).toMatchObject({ status: "partially_refunded", amountRefundedCents: 900 });
    expect(audit.record).toHaveBeenCalledWith("billing.invoices.sync", expect.objectContaining({ metadata: { mode: "test", recorded: 2, skipped: 2 } }));
  });
});
