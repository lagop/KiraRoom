import { ConflictException, ForbiddenException } from "@nestjs/common";
import { PosService } from "./pos.service";
import { splitTicket } from "../payments/appointment-payment";

/**
 * Charging an appointment at the till ("cobrar") took two calls: the sale
 * recorded a payment with no appointment on it, then the panel marked the
 * appointment paid with a separate PATCH, for whatever amount it sent. The
 * appointment never knew which payment paid it, a failure in between left
 * them disagreeing, and cancelled or no-show visits could be charged.
 *
 * Now one checkout: each appointment gets its own payment row
 * (Payment.appointmentId) and its paid amount and payment status, in the
 * same transaction, and a visit that did not happen is refused with a 409.
 */

type Row = Record<string, any>;

function apt(id: string, over: Row = {}): Row {
  return {
    id,
    tenantId: "t1",
    clientId: "c1",
    professionalId: "p-me",
    status: "completed",
    paymentStatus: "pending",
    amountPaid: 0,
    totalAmount: 4000, // cents
    service: { price: 40 },
    ...over,
  };
}

function till(appointments: Row[], opts: { loyalty?: Row; failUpdate?: boolean } = {}) {
  const committed = { payments: [] as Row[], appointments: new Map(appointments.map((a) => [a.id, { ...a }])) };
  const db = (pending: { payments: Row[]; updates: [string, Row][] }) => ({
    payment: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `pay${committed.payments.length + pending.payments.length + 1}`, ...data };
        pending.payments.push(row);
        return row;
      }),
    },
    appointment: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const a = committed.appointments.get(where.id)!;
        const ok =
          !opts.failUpdate &&
          Number(a.amountPaid) === Number(where.amountPaid) &&
          a.paymentStatus !== where.paymentStatus.not &&
          !where.status.notIn.includes(a.status);
        if (ok) pending.updates.push([where.id, data]);
        return { count: ok ? 1 : 0 };
      }),
    },
  });
  const commit = (pending: { payments: Row[]; updates: [string, Row][] }) => {
    committed.payments.push(...pending.payments);
    for (const [id, data] of pending.updates) Object.assign(committed.appointments.get(id)!, data);
  };

  const prisma: any = {
    appointment: {
      findMany: jest.fn(async ({ where }: any) =>
        [...committed.appointments.values()].filter((a) => where.id.in.includes(a.id) && a.tenantId === where.tenantId),
      ),
    },
    professional: { findFirst: jest.fn(async ({ where }: any) => (where.userId === "u-me" ? { id: "p-me" } : null)) },
    client: { findFirst: jest.fn(), create: jest.fn() },
    // A transaction: everything written inside it lands, or nothing does.
    $transaction: jest.fn(async (fn: any) => {
      const pending = { payments: [] as Row[], updates: [] as [string, Row][] };
      const out = await fn(db(pending));
      commit(pending);
      return out;
    }),
  };
  // Outside a transaction (walk-in sales), writes land at once.
  const direct = { payments: [] as Row[], updates: [] as [string, Row][] };
  Object.assign(prisma, { payment: db(direct).payment });

  const loyalty: any = {
    redeemAtSale: jest.fn(async () => ({ discountCents: 1000, pointsSpent: 100, rewardName: "10 EUR", redemptionId: "r1" })),
    cancelSaleRedemption: jest.fn(async () => undefined),
    earnForSale: jest.fn(async () => 0),
    settleAppointment: jest.fn(async () => ({ awarded: 0 })),
    ...opts.loyalty,
  };
  const wallet: any = { deductFunds: jest.fn(async () => ({})), addFunds: jest.fn(async () => ({})) };
  const service = new PosService(prisma, wallet, loyalty);
  return { service, prisma, loyalty, wallet, committed };
}

const OWNER = { id: "u-owner", role: "owner" };
const STAFF = { id: "u-me", role: "staff" };
const item = (price: number, serviceId = "svc1") => ({ serviceId, name: "Corte", price, quantity: 1 });

describe("POS: charging an appointment", () => {
  it("records the payment on the appointment and marks it paid, in one transaction", async () => {
    const t = till([apt("a1")]);
    await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [item(4000)],
      payments: [{ method: "card", amount: 4000 }],
      actor: OWNER,
    } as any);

    expect(t.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(t.committed.payments).toEqual([
      expect.objectContaining({ appointmentId: "a1", amount: 4000, method: "card", status: "paid", type: "appointment" }),
    ]);
    expect(t.committed.appointments.get("a1")).toMatchObject({
      amountPaid: 4000,
      paymentStatus: "paid",
      paymentMethod: "card",
      // The visit's status is the agenda's: completing it issues the invoice.
      status: "completed",
    });
    // Points through the appointment, now that its payment is on it.
    expect(t.loyalty.settleAppointment).toHaveBeenCalledWith("t1", "a1");
  });

  it("splits one ticket over several appointments, each with its own row", async () => {
    const t = till([apt("a1"), apt("a2", { totalAmount: 2500, clientId: "c2" })]);
    await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1", "a2"],
      items: [item(4000), item(2500, "svc2"), { name: "Champú", price: 1200, quantity: 1 }],
      payments: [{ method: "cash", amount: 7700 }],
      actor: OWNER,
    } as any);

    expect(t.committed.payments.map((p) => [p.appointmentId ?? null, p.amount, p.clientId])).toEqual([
      ["a1", 4000, "c1"],
      ["a2", 2500, "c2"],
      // The product: a payment of the ticket, not of either appointment.
      [null, 1200, "c1"],
    ]);
    expect(t.committed.appointments.get("a2")).toMatchObject({ amountPaid: 2500, paymentStatus: "paid" });
  });

  it("leaves an appointment the ticket does not cover partly paid, not paid", async () => {
    const t = till([apt("a1")]);
    await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      // A price typed lower at the till: the appointment's own total decides.
      items: [item(1500)],
      payments: [{ method: "cash", amount: 1500 }],
      actor: OWNER,
    } as any);
    expect(t.committed.appointments.get("a1")).toMatchObject({ amountPaid: 1500, paymentStatus: "pending" });
  });

  it("takes the client's loyalty reward off the appointment: the rest pays it in full", async () => {
    const t = till([apt("a1")]);
    const out: any = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [item(4000)],
      payments: [{ method: "card", amount: 3000 }],
      loyaltyRewardId: "rw1",
      actor: OWNER,
    } as any);

    expect(t.loyalty.redeemAtSale).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ rewardId: "rw1", appointmentId: "a1", subtotalCents: 4000 }),
    );
    expect(out.total).toBe(3000);
    expect(out.loyalty).toMatchObject({ discount: 1000, pointsSpent: 100 });
    // 30 EUR of money and 10 EUR of points: paid. Only the money is a payment
    // row, so the visit earns on 30 EUR (LoyaltyService subtracts the reward).
    expect(t.committed.payments).toEqual([expect.objectContaining({ appointmentId: "a1", amount: 3000 })]);
    expect(t.committed.appointments.get("a1")).toMatchObject({ amountPaid: 4000, paymentStatus: "paid" });
  });

  it("refuses cancelled and no-show appointments with a 409, before spending points or money", async () => {
    for (const [status, words] of [
      ["cancelled", "cancelada"],
      ["no_show", "no presentada"],
    ]) {
      const t = till([apt("a1"), apt("a2", { status })]);
      const err = await t.service
        .processCheckout({
          tenantId: "t1",
          clientId: "c1",
          appointmentIds: ["a1", "a2"],
          items: [item(8000)],
          payments: [{ method: "wallet", amount: 8000 }],
          loyaltyRewardId: "rw1",
          actor: OWNER,
        } as any)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "APPOINTMENT_NOT_CHARGEABLE", appointmentId: "a2" });
      expect(err.message).toContain(words);
      expect(t.loyalty.redeemAtSale).not.toHaveBeenCalled();
      expect(t.wallet.deductFunds).not.toHaveBeenCalled();
      expect(t.committed.payments).toHaveLength(0);
    }
  });

  it("refuses an appointment already paid", async () => {
    const t = till([apt("a1", { paymentStatus: "paid", amountPaid: 4000 })]);
    await expect(
      t.service.processCheckout({
        tenantId: "t1",
        clientId: "c1",
        appointmentIds: ["a1"],
        items: [item(4000)],
        payments: [{ method: "cash", amount: 4000 }],
        actor: OWNER,
      } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("a staff member charges their own appointments only", async () => {
    const t = till([apt("a1"), apt("a2", { professionalId: "p-colleague" })]);
    await expect(
      t.service.processCheckout({
        tenantId: "t1",
        clientId: "c1",
        appointmentIds: ["a1", "a2"],
        items: [item(8000)],
        payments: [{ method: "cash", amount: 8000 }],
        actor: STAFF,
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.committed.payments).toHaveLength(0);

    await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [item(4000)],
      payments: [{ method: "cash", amount: 4000 }],
      actor: STAFF,
    } as any);
    expect(t.committed.appointments.get("a1")).toMatchObject({ paymentStatus: "paid" });
  });

  it("when another till charged it first, nothing is recorded and the points and wallet money go back", async () => {
    const t = till([apt("a1")], { failUpdate: true });
    await expect(
      t.service.processCheckout({
        tenantId: "t1",
        clientId: "c1",
        appointmentIds: ["a1"],
        items: [item(4000)],
        payments: [{ method: "wallet", amount: 3000 }],
        loyaltyRewardId: "rw1",
        actor: OWNER,
      } as any),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "APPOINTMENT_PAYMENT_CHANGED" }) });
    expect(t.committed.payments).toHaveLength(0);
    expect(t.loyalty.cancelSaleRedemption).toHaveBeenCalledTimes(1);
    expect(t.wallet.addFunds).toHaveBeenCalledWith("t1", "c1", 3000, expect.any(String));
  });
});

describe("splitTicket", () => {
  const a = (id: string, totalAmount: number, amountPaid = 0) =>
    ({ id, status: "completed", paymentStatus: "pending", amountPaid, totalAmount }) as any;

  it("covers what each appointment still owes, reward first, then each tender in order", () => {
    const { rows, shares } = splitTicket(
      [a("a1", 4000, 1000), a("a2", 2000)],
      [
        { method: "card", amount: 2500 },
        { method: "cash", amount: 2000 },
      ],
      500,
    );
    expect(rows.map((r) => [r.method, r.amount, r.appointment?.id ?? null])).toEqual([
      ["card", 2500, "a1"],
      ["cash", 2000, "a2"],
    ]);
    expect(shares.map((s) => [s.fromDiscount, s.fromMoney, s.methods])).toEqual([
      [500, 2500, ["card"]],
      [0, 2000, ["cash"]],
    ]);
  });

  it("never allocates past what is owed; the rest is a row of the ticket", () => {
    const { rows } = splitTicket([a("a1", 1000)], [{ method: "cash", amount: 1500 }], 0);
    expect(rows.map((r) => [r.amount, r.appointment?.id ?? null])).toEqual([
      [1000, "a1"],
      [500, null],
    ]);
  });
});
