import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { AppointmentsService } from "../appointments.service";
import { DepositsService, DEPOSIT_HOLD_MS, depositCents } from "./deposits.service";
import { StripeConnectWebhookController } from "./deposits.controller";

/**
 * Deposits against no-shows. Services had depositRequired / depositAmount /
 * depositPercentage and appointments a depositPaid flag, but nothing charged
 * anything. Now an online booking for such a service is held as pending and
 * the client pays on Stripe Checkout, on the salon's own connected account.
 */

const ACCOUNT = "acct_salon1";

function config(env: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: "sk_test_dummy",
    FRONTEND_URL: "https://app.example.test",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_dummy",
    ...env,
  };
  return { get: (k: string) => values[k] } as any;
}

function appointmentRow(overrides: Record<string, any> = {}) {
  return {
    id: "apt-1",
    tenantId: "tenant-1",
    clientId: "client-1",
    currency: "EUR",
    status: "pending",
    depositPaid: false,
    depositAmount: 10,
    service: { name: "Corte", price: 40, depositRequired: true, depositAmount: 10, depositPercentage: null },
    client: { email: "ana@mail.test" },
    tenant: { stripeConnectAccountId: ACCOUNT, stripeConnectChargesEnabled: true, slug: "salon-uno", name: "Salón Uno" },
    ...overrides,
  };
}

function build({ appointment = appointmentRow() as any, env = {} as Record<string, string | undefined> } = {}) {
  const updates: any[] = [];
  const updateMany: any[] = [];
  const payments: any[] = [];
  const prisma: any = {
    appointment: {
      findUnique: jest.fn(async () => appointment),
      findMany: jest.fn(async () => [] as any[]),
      update: jest.fn((args: any) => { updates.push(args); return args; }),
      updateMany: jest.fn(async (args: any) => { updateMany.push(args); return { count: 1 }; }),
    },
    payment: { create: jest.fn((args: any) => { payments.push(args); return args; }) },
    tenant: { updateMany: jest.fn(async () => ({ count: 1 })) },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const deposits = new DepositsService(prisma, config(env));
  const sessions = { create: jest.fn(async () => ({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" })) };
  if ((deposits as any).stripe) (deposits as any).stripe = { checkout: { sessions } };
  return { deposits, prisma, sessions, updates, updateMany, payments };
}

const completed = (overrides: Record<string, any> = {}, account: string | null = ACCOUNT) =>
  ({
    type: "checkout.session.completed",
    account,
    data: {
      object: {
        id: "cs_test_1",
        payment_status: "paid",
        amount_total: 1000,
        currency: "eur",
        payment_intent: "pi_1",
        metadata: { kind: "deposit", appointmentId: "apt-1" },
        ...overrides,
      },
    },
  }) as any;

describe("depositCents", () => {
  it("is 0 when the service asks for no deposit", () => {
    expect(depositCents({ depositRequired: false, depositAmount: 10, price: 40 })).toBe(0);
  });

  it("uses the fixed amount, in euros, first", () => {
    expect(depositCents({ depositRequired: true, depositAmount: "12.50", depositPercentage: 50, price: 40 })).toBe(1250);
  });

  it("otherwise takes the percentage of the price", () => {
    expect(depositCents({ depositRequired: true, depositAmount: null, depositPercentage: 25, price: "45.00" })).toBe(1125);
  });

  it("is 0 when required but with no amount or percentage", () => {
    expect(depositCents({ depositRequired: true, depositAmount: 0, depositPercentage: 0, price: 40 })).toBe(0);
  });
});

describe("startDeposit", () => {
  it("opens a Checkout on the salon's account and holds the slot", async () => {
    const { deposits, sessions, updates } = build();
    const before = Date.now();
    const result = await deposits.startDeposit("apt-1", "/sites/salon-uno");

    expect(result).toMatchObject({ amountCents: 1000, checkoutUrl: "https://checkout.stripe.test/cs_test_1" });
    expect(result!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + DEPOSIT_HOLD_MS);

    const [params, options] = (sessions.create.mock.calls[0] as unknown) as [any, any];
    // A direct charge on the salon's account; no KiraRoom fee.
    expect(options).toEqual({ stripeAccount: ACCOUNT });
    expect(params.payment_intent_data.application_fee_amount).toBeUndefined();
    expect(params.line_items[0].price_data).toMatchObject({ currency: "eur", unit_amount: 1000 });
    expect(params.metadata).toMatchObject({ kind: "deposit", appointmentId: "apt-1" });
    expect(params.customer_email).toBe("ana@mail.test");
    expect(params.success_url).toBe("https://app.example.test/sites/salon-uno?deposit=paid");
    expect(params.cancel_url).toBe("https://app.example.test/sites/salon-uno?deposit=cancelled");
    // Stripe accepts expires_at from 30 minutes on.
    expect(params.expires_at * 1000 - before).toBeGreaterThanOrEqual(30 * 60 * 1000);

    expect(updates[0].data).toMatchObject({
      depositRequired: true,
      depositAmount: 10,
      depositCheckoutSessionId: "cs_test_1",
    });
  });

  it("returns to the salon site when no return path is given", async () => {
    const { deposits, sessions } = build();
    await deposits.startDeposit("apt-1");
    expect((sessions.create.mock.calls[0] as any)[0].success_url).toBe(
      "https://app.example.test/sites/salon-uno?deposit=paid",
    );
  });

  it.each([
    ["the service asks for no deposit", { service: { name: "Corte", price: 40, depositRequired: false } }],
    ["the salon has not connected Stripe", { tenant: { stripeConnectAccountId: null, stripeConnectChargesEnabled: false, slug: "s" } }],
    ["the salon's account cannot charge yet", { tenant: { stripeConnectAccountId: ACCOUNT, stripeConnectChargesEnabled: false, slug: "s" } }],
  ])("books without a deposit when %s", async (_why, overrides) => {
    const { deposits, sessions, updates } = build({ appointment: appointmentRow(overrides) });
    expect(await deposits.startDeposit("apt-1")).toBeNull();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("books without a deposit until the Connect webhook is configured", async () => {
    // Nothing would mark it paid, and the cron would free a paid slot.
    const { deposits, sessions } = build({ env: { STRIPE_CONNECT_WEBHOOK_SECRET: undefined } });
    expect(await deposits.startDeposit("apt-1")).toBeNull();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("books without a deposit when KiraRoom has no Stripe key", async () => {
    const { deposits } = build({ env: { STRIPE_SECRET_KEY: undefined } });
    expect(await deposits.startDeposit("apt-1")).toBeNull();
  });
});

describe("handleConnectEvent", () => {
  it("marks the deposit paid, confirms the booking and records the payment", async () => {
    const { deposits, updates, payments } = build();
    expect(await deposits.handleConnectEvent(completed())).toEqual({ paidAppointmentId: "apt-1" });
    expect(updates[0].data).toMatchObject({ depositPaid: true, depositPaymentIntentId: "pi_1", status: "confirmed" });
    expect(payments[0].data).toMatchObject({ amount: 1000, currency: "EUR", type: "deposit", status: "paid", appointmentId: "apt-1" });
  });

  it("counts a Stripe retry only once", async () => {
    const { deposits, payments } = build({ appointment: appointmentRow({ depositPaid: true }) });
    expect(await deposits.handleConnectEvent(completed())).toEqual({});
    expect(payments).toEqual([]);
  });

  it("ignores an event from another salon's account", async () => {
    const { deposits, payments } = build();
    expect(await deposits.handleConnectEvent(completed({}, "acct_other"))).toEqual({});
    expect(payments).toEqual([]);
  });

  it("ignores checkouts that are not deposits or not paid yet", async () => {
    const { deposits, payments } = build();
    expect(await deposits.handleConnectEvent(completed({ metadata: { kind: "subscription" } }))).toEqual({});
    expect(await deposits.handleConnectEvent(completed({ payment_status: "unpaid" }))).toEqual({});
    expect(payments).toEqual([]);
  });

  it("releases the slot when the checkout expires unpaid", async () => {
    const { deposits, updateMany } = build();
    await deposits.handleConnectEvent({ ...completed(), type: "checkout.session.expired" });
    expect(updateMany[0].where).toMatchObject({ id: "apt-1", depositPaid: false, status: "pending" });
    expect(updateMany[0].data).toMatchObject({ status: "cancelled" });
  });

  it("keeps the salon's charges_enabled in step with Stripe", async () => {
    const { deposits, prisma } = build();
    await deposits.handleConnectEvent({ type: "account.updated", data: { object: { id: ACCOUNT, charges_enabled: true } } } as any);
    expect(prisma.tenant.updateMany).toHaveBeenCalledWith({
      where: { stripeConnectAccountId: ACCOUNT },
      data: { stripeConnectChargesEnabled: true },
    });
  });
});

describe("releaseExpired", () => {
  it("cancels pending bookings whose deposit hold ran out", async () => {
    const { deposits, prisma, updateMany } = build();
    prisma.appointment.findMany.mockResolvedValue([{ id: "apt-1" }, { id: "apt-2" }]);
    expect(await deposits.releaseExpired()).toBe(2);
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ depositPaid: false, status: "pending" });
    expect(where.depositExpiresAt.lt.getTime()).toBeLessThan(Date.now());
    expect(updateMany.map((u) => u.where.id)).toEqual(["apt-1", "apt-2"]);
  });
});

describe("constructEvent", () => {
  it("is unavailable without the Connect webhook secret", () => {
    const { deposits } = build({ env: { STRIPE_CONNECT_WEBHOOK_SECRET: undefined } });
    expect(() => deposits.constructEvent("{}", "sig")).toThrow(ServiceUnavailableException);
  });
});

describe("POST /webhooks/stripe/connect", () => {
  function controller(event: any, handled: any = {}) {
    const deposits: any = {
      constructEvent: jest.fn(() => {
        if (event instanceof Error) throw event;
        return event;
      }),
      handleConnectEvent: jest.fn(async () => handled),
    };
    const appointments: any = { onDepositPaid: jest.fn(async () => undefined) };
    return { c: new StripeConnectWebhookController(deposits, appointments), deposits, appointments };
  }
  const req = { rawBody: Buffer.from("{}") } as any;

  it("refuses a request with no signature", async () => {
    const { c } = controller({});
    await expect(c.handle(undefined as any, req)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a bad signature with a 400", async () => {
    const { c } = controller(new Error("No signatures found"));
    await expect(c.handle("t=1,v1=bad", req)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("sends the confirmation once the deposit is paid", async () => {
    const { c, appointments } = controller(completed(), { paidAppointmentId: "apt-1" });
    expect(await c.handle("t=1,v1=ok", req)).toEqual({ received: true });
    expect(appointments.onDepositPaid).toHaveBeenCalledWith("apt-1");
  });

  it("acknowledges the event even if the notifications fail", async () => {
    const { c, appointments } = controller(completed(), { paidAppointmentId: "apt-1" });
    appointments.onDepositPaid.mockRejectedValue(new Error("SMTP down"));
    expect(await c.handle("t=1,v1=ok", req)).toEqual({ received: true });
  });
});

describe("bookOnline with a deposit", () => {
  function service(deposits: any) {
    const updates: any[] = [];
    const prisma: any = { appointment: { update: async (args: any) => updates.push(args) } };
    const stub = {} as any;
    const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub, undefined, undefined, undefined, undefined, undefined, deposits);
    return { svc, updates };
  }

  it("cancels the booking and answers 503 when Stripe fails", async () => {
    const { svc, updates } = service({ startDeposit: async () => { throw new Error("Stripe is down"); } });
    await expect((svc as any).holdForDeposit("apt-1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(updates[0]).toMatchObject({ where: { id: "apt-1" }, data: { status: "cancelled" } });
  });

  it("holds nothing without the deposits service", async () => {
    const { svc } = service(undefined);
    expect(await (svc as any).holdForDeposit("apt-1")).toBeNull();
  });
});
