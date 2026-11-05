import { BadRequestException, ConflictException } from "@nestjs/common";
import { LoyaltyService } from "./loyalty.service";

/**
 * Points used to move only when someone typed them in: no visit or sale
 * earned anything and no client could join. They now follow the money, and
 * because the same completion/payment hooks fire from several code paths
 * (plus an hourly sweep), the one property that matters most is that a
 * visit or sale never earns twice, and a refund never takes back twice.
 */

type Row = Record<string, any>;

function fakeDb(opts: { program?: Partial<Row>; unlocked?: boolean } = {}) {
  const program: Row = {
    id: "prog1",
    tenantId: "t1",
    isActive: true,
    earnMode: "per_euro",
    pointsPerEuro: 1,
    pointsPerVisit: 10,
    autoEnroll: false,
    allowSelfEnroll: true,
    welcomePoints: 0,
    minPointsRedemption: 0,
    name: "Club",
    ...opts.program,
  };
  const members: Row[] = [];
  const txs: Row[] = [];
  const appointments: Row[] = [];
  const redemptions: Row[] = [];
  const rewards: Row[] = [];
  const payments: Row[] = [];
  const tiers: Row[] = [];
  let seq = 0;

  const memberKey = (w: any) =>
    w.id
      ? members.find((m) => m.id === w.id)
      : members.find((m) => m.clientId === w.clientId_programId.clientId && m.programId === w.clientId_programId.programId);

  const inc = (m: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in v) m[k] = (m[k] ?? 0) + (v as any).increment;
      else if (v && typeof v === "object" && "decrement" in v) m[k] = (m[k] ?? 0) - (v as any).decrement;
      else if (v !== undefined) m[k] = v;
    }
    return m;
  };

  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if ("path" in v) return row[k]?.[(v as any).path[0]] === (v as any).equals;
        if ("not" in v) return row[k] !== (v as any).not;
        if ("in" in v) return (v as any).in.includes(row[k]);
        return true;
      }
      return row[k] === v;
    });

  // A Prisma-like where for members: equality, null, gt/gte/lt/in, OR, and
  // the tier relation (tier.minPoints).
  const cmp = (val: any, cond: any): boolean => {
    if (cond === null) return val === null || val === undefined;
    if (cond instanceof Date) return val instanceof Date && val.getTime() === cond.getTime();
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const v = val instanceof Date ? val.getTime() : val;
      const at = (x: any) => (x instanceof Date ? x.getTime() : x);
      if ("gt" in cond && !(v != null && v > at(cond.gt))) return false;
      if ("gte" in cond && !(v != null && v >= at(cond.gte))) return false;
      if ("lt" in cond && !(v != null && v < at(cond.lt))) return false;
      if ("lte" in cond && !(v != null && v <= at(cond.lte))) return false;
      if ("in" in cond && !cond.in.includes(val)) return false;
      if ("not" in cond && val === cond.not) return false;
      return true;
    }
    return val === cond;
  };
  const memberMatch = (m: Row, where: Row): boolean =>
    Object.entries(where ?? {}).every(([k, cond]) => {
      if (k === "OR") return (cond as Row[]).some((w) => memberMatch(m, w));
      if (k === "tier") {
        const t = tiers.find((x) => x.id === m.tierId);
        return !!t && cmp(t.minPoints, (cond as any).minPoints);
      }
      return cmp(m[k], cond);
    });

  const prisma: any = {
    loyaltyProgram: {
      findMany: jest.fn(async () => [{ ...program, tenant: { timezone: "Europe/Madrid" } }]),
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === program.tenantId && (where.isActive === undefined || where.isActive === program.isActive)
          ? program
          : null,
      ),
    },
    loyaltyMember: {
      findUnique: jest.fn(async ({ where }: any) => {
        const m = memberKey(where);
        return m ? { ...m, tier: null } : null;
      }),
      findFirst: jest.fn(async ({ where }: any) => members.find((m) => m.id === where.id) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const m = {
          id: `m${++seq}`,
          status: "active",
          currentPoints: 0,
          lifetimePoints: 0,
          totalEarned: 0,
          totalRedeemed: 0,
          totalSpent: 0,
          tierId: null,
          peakLifetimePoints: 0,
          joinedAt: new Date(),
          ...data,
        };
        members.push(m);
        return m;
      }),
      update: jest.fn(async ({ where, data }: any) => inc(members.find((m) => m.id === where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = members.filter((m) => memberMatch(m, where));
        hit.forEach((m) => inc(m, data));
        return { count: hit.length };
      }),
      findMany: jest.fn(async ({ where, take }: any) => {
        const rows = members.filter((m) => memberMatch(m, where)).sort((a, b) => (a.id < b.id ? -1 : 1));
        return take ? rows.slice(0, take) : rows;
      }),
    },
    loyaltyTransaction: {
      create: jest.fn(async ({ data }: any) => {
        if (
          data.sourceId != null &&
          txs.some(
            (t) => t.memberId === data.memberId && t.type === data.type && t.source === data.source && t.sourceId === data.sourceId,
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const t = { id: `tx${++seq}`, createdAt: new Date(), ...data };
        txs.push(t);
        return t;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const t = txs.find((x) => matches(x, where));
        return t ? { ...t, member: { clientId: members.find((m) => m.id === t.memberId)?.clientId } } : null;
      }),
      findMany: jest.fn(async ({ where }: any) => txs.filter((x) => matches(x, where))),
    },
    loyaltyTier: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.id) return tiers.find((t) => t.id === where.id) ?? null;
        const fit = tiers
          .filter((t) => t.programId === where.programId && t.minPoints <= where.minPoints.lte)
          .sort((a, b) => b.minPoints - a.minPoints);
        return fit[0] ?? null;
      }),
      findUnique: jest.fn(async ({ where }: any) => tiers.find((t) => t.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        tiers.filter((t) => t.programId === where.programId).sort((a, b) => a.minPoints - b.minPoints),
      ),
      update: jest.fn(async ({ where, data }: any) => inc(tiers.find((t) => t.id === where.id)!, data)),
      delete: jest.fn(async ({ where }: any) => {
        const i = tiers.findIndex((t) => t.id === where.id);
        const [t] = tiers.splice(i, 1);
        // onDelete: SetNull
        members.filter((m) => m.tierId === t.id).forEach((m) => (m.tierId = null));
        return t;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (tiers.some((t) => t.programId === data.programId && t.name === data.name)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const t = { id: `tier${++seq}`, ...data };
        tiers.push(t);
        return t;
      }),
    },
    loyaltyReward: {
      findFirst: jest.fn(async ({ where }: any) => rewards.find((r) => r.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => inc(rewards.find((r) => r.id === where.id)!, data)),
      // redeemAtSale's conditional claim: no limit, or uses below it.
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = rewards.find((x) => x.id === where.id);
        if (!r) return { count: 0 };
        if (where.OR && !(r.maxRedemptions == null || r.currentRedemptions < r.maxRedemptions)) return { count: 0 };
        if (where.currentRedemptions?.gt !== undefined && !(r.currentRedemptions > where.currentRedemptions.gt)) {
          return { count: 0 };
        }
        inc(r, data);
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: `rw${++seq}`, currentRedemptions: 0, ...data };
        rewards.push(r);
        return r;
      }),
      fields: { maxRedemptions: "maxRedemptions" },
    },
    loyaltyRedemption: {
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          valueReceived:
            redemptions
              .filter((r) => r.appointmentId === where.appointmentId && r.status !== "cancelled")
              .reduce((s, r) => s + r.valueReceived, 0) || null,
        },
      })),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: `r${++seq}`, ...data };
        redemptions.push(r);
        return r;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        redemptions.filter((r) => r.posSaleId === where.posSaleId && r.status !== "cancelled"),
      ),
      update: jest.fn(async ({ where, data }: any) => inc(redemptions.find((r) => r.id === where.id)!, data)),
    },
    appointment: {
      findFirst: jest.fn(async ({ where }: any) => appointments.find((a) => a.id === where.id && a.tenantId === where.tenantId) ?? null),
    },
    client: {
      findFirst: jest.fn(async ({ where }: any) => (where.tenantId === "t1" ? { id: where.id } : null)),
      update: jest.fn(async () => ({})),
    },
    payment: {
      count: jest.fn(async ({ where }: any) => payments.filter((p) => matches(p, where)).length),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));

  const flags: any = { isFeatureUnlocked: jest.fn(async () => opts.unlocked ?? true) };
  const service = new LoyaltyService(prisma, flags);
  const member = (clientId = "c1") => members.find((m) => m.clientId === clientId);
  return { service, prisma, program, members, txs, appointments, redemptions, rewards, payments, tiers, member };
}

function paidVisit(over: Row = {}) {
  return {
    id: "a1",
    tenantId: "t1",
    clientId: "c1",
    status: "completed",
    paymentStatus: "paid",
    amountPaid: 4550, // 45,50 EUR, in cents
    totalAmount: 4550,
    service: { price: 45.5 },
    // The payment recorded against it (the till, the payments screen...).
    payments: [{ amount: 4550, method: "cash" }],
    ...over,
  };
}

describe("LoyaltyService: earning", () => {
  it("a completed and paid appointment earns points per euro, once", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit());

    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 45 });
    // The hook fires again (payment recorded after completion, the sweep...).
    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 0 });
    expect(db.member()!.currentPoints).toBe(45);
    expect(db.txs.filter((t) => t.type === "earn")).toHaveLength(1);
  });

  it("earns nothing until the appointment is both completed and paid", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit({ status: "confirmed" }));
    expect(await db.service.settleAppointment("t1", "a1")).toBeNull();
    db.appointments[0].status = "completed";
    db.appointments[0].paymentStatus = "pending";
    db.appointments[0].payments = [];
    expect(await db.service.settleAppointment("t1", "a1")).toBeNull();
    expect(db.txs).toHaveLength(0);
  });

  it("a payment status set by hand, with no payment recorded, earns nothing", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    // What PATCH /appointments/:id/payment used to be enough for.
    db.appointments.push(paidVisit({ payments: [], amountPaid: 99900 }));
    expect(await db.service.settleAppointment("t1", "a1")).toBeNull();
    // Points paid with points are not money either.
    db.appointments[0].payments = [{ amount: 4550, method: "loyalty_points" }];
    expect(await db.service.settleAppointment("t1", "a1")).toBeNull();
    expect(db.txs).toHaveLength(0);
  });

  it("earns on the money recorded, not on a paid amount typed higher", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit({ amountPaid: 4550, payments: [{ amount: 1000, method: "card" }] }));
    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 10 });
  });

  it("a non-member earns nothing unless the salon auto-enrols, then joins with the welcome points", async () => {
    const off = fakeDb();
    off.appointments.push(paidVisit());
    expect(await off.service.settleAppointment("t1", "a1")).toBeNull();
    expect(off.members).toHaveLength(0);

    const on = fakeDb({ program: { autoEnroll: true, welcomePoints: 50 } });
    on.appointments.push(paidVisit());
    expect(await on.service.settleAppointment("t1", "a1")).toEqual({ awarded: 45 });
    expect(on.member()).toMatchObject({ enrolledVia: "auto", currentPoints: 95 });
  });

  it("per-visit mode gives the same points whatever the visit cost", async () => {
    const db = fakeDb({ program: { earnMode: "per_visit", pointsPerVisit: 10 } });
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit({ amountPaid: 99900 }));
    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 10 });
  });

  it("does nothing when the plan no longer includes loyalty", async () => {
    const db = fakeDb({ unlocked: false });
    db.appointments.push(paidVisit());
    expect(await db.service.settleAppointment("t1", "a1")).toBeNull();
  });

  it("the part paid with points earns nothing", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit());
    db.redemptions.push({ id: "r0", appointmentId: "a1", valueReceived: 2550, status: "completed" });
    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 20 });
  });
});

describe("LoyaltyService: reversal", () => {
  it("a cancelled appointment gives its points back once, the balance going negative if she spent them", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit());
    await db.service.settleAppointment("t1", "a1");
    // The client already spent 30 of the 45 points.
    db.member()!.currentPoints = 15;

    // All 45 come back (it used to stop at 0, and she kept the reward free).
    expect(await db.service.reverseAppointment("t1", "a1", "Cita cancelada")).toBe(-45);
    expect(await db.service.reverseAppointment("t1", "a1", "Cita cancelada")).toBe(0);
    expect(db.member()!.currentPoints).toBe(-30);
  });

  it("a refunded till payment takes back its share of the sale", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    // 60 EUR ticket paid half cash, half card.
    expect(await db.service.earnForSale("t1", { clientId: "c1", saleId: "s1", basisCents: 6000, isVisit: true })).toBe(60);
    db.payments.push({ id: "p1", tenantId: "t1", status: "paid", metadata: { posSaleId: "s1" } });
    db.payments.push({ id: "p2", tenantId: "t1", status: "refunded", metadata: { posSaleId: "s1" } });

    const p2 = { id: "p2", amount: 3000, metadata: { posSaleId: "s1" } };
    await db.service.onPaymentRefunded("t1", p2, { id: "rf2", amount: 3000 });
    // The same refund again (a retry) takes nothing more.
    await db.service.onPaymentRefunded("t1", p2, { id: "rf2", amount: 3000 });
    expect(db.member()!.currentPoints).toBe(30);
  });

  it("a partial refund of a visit takes back its share with a ledger entry, once; the full reversal only the rest", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit({ amountPaid: 4000, totalAmount: 4000, payments: [{ amount: 4000, method: "card" }] }));
    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 40 });

    // 10,00 of 40,00 back: 10 points.
    expect(await db.service.onPartialRefund("t1", { id: "p1", appointmentId: "a1" }, { id: "r1", amount: 1000 })).toBe(-10);
    // The same refund again (a retry) takes nothing more.
    expect(await db.service.onPartialRefund("t1", { id: "p1", appointmentId: "a1" }, { id: "r1", amount: 1000 })).toBe(0);
    expect(db.member()!.currentPoints).toBe(30);
    expect(db.txs.find((t) => t.source === "refund")).toMatchObject({
      type: "reversal",
      points: -10,
      sourceId: "r1",
      description: "Devolución parcial",
      metadata: { appointmentId: "a1", paymentId: "p1", refundCents: 1000 },
    });

    // The rest refunded: the visit is reversed for what is left (30), not 40.
    expect(await db.service.reverseAppointment("t1", "a1", "Devolución del pago de la cita")).toBe(-30);
    expect(db.member()!.currentPoints).toBe(0);
    // Nothing more once it was reversed in full.
    expect(await db.service.onPartialRefund("t1", { id: "p1", appointmentId: "a1" }, { id: "r2", amount: 1000 })).toBe(0);
  });

  it("partial refunds of a sale never take more than it earned; a short balance goes negative", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    await db.service.earnForSale("t1", { clientId: "c1", saleId: "s1", basisCents: 6000, isVisit: true });
    const payment = { id: "p1", metadata: { posSaleId: "s1" } };
    // 20,00 of 60,00: 20 points.
    expect(await db.service.onPartialRefund("t1", payment, { id: "r1", amount: 2000 })).toBe(-20);
    // The client spent most of what is left: a refund worth 30 takes 30 all the same.
    db.member()!.currentPoints = 5;
    expect(await db.service.onPartialRefund("t1", payment, { id: "r2", amount: 3000 })).toBe(-30);
    expect(db.member()!.currentPoints).toBe(-25);

    // The rest of the payment (10,00) refunded: its share, 10, which is all
    // that is left of the 60: never more than the sale earned.
    db.payments.push({ id: "p1", tenantId: "t1", status: "refunded", metadata: { posSaleId: "s1" } });
    await db.service.onPaymentRefunded("t1", { id: "p1", amount: 6000, metadata: { posSaleId: "s1" } }, { id: "r3", amount: 1000 });
    expect(db.member()!.currentPoints).toBe(-35);
    const back = db.txs.filter((t) => t.type === "reversal").reduce((s, t) => s - t.points, 0);
    expect(back).toBe(60);
  });

  it("a products-only ticket earns nothing in per-visit mode", async () => {
    const db = fakeDb({ program: { earnMode: "per_visit" } });
    await db.service.enroll("t1", "c1", "staff");
    expect(await db.service.earnForSale("t1", { clientId: "c1", saleId: "s1", basisCents: 2000, isVisit: false })).toBe(0);
  });
});

describe("LoyaltyService: redemption at the till", () => {
  function withReward(over: Row = {}) {
    const db = fakeDb({ program: { minPointsRedemption: 50 } });
    db.rewards.push({
      id: "rw1",
      programId: "prog1",
      name: "10 % de descuento",
      type: "discount",
      pointsCost: 100,
      discountPercent: 10,
      discountAmount: null,
      freeServiceId: null,
      isActive: true,
      currentRedemptions: 0,
      maxRedemptions: null,
      expiresAt: null,
      ...over,
    });
    return db;
  }
  const items = [{ serviceId: "svc1", price: 4000, quantity: 1 }];

  it("spends the points and returns the discount in cents", async () => {
    const db = withReward();
    await db.service.enroll("t1", "c1", "staff");
    db.member()!.currentPoints = 130;
    const out = await db.service.redeemAtSale("t1", {
      clientId: "c1",
      rewardId: "rw1",
      saleId: "s1",
      items,
      subtotalCents: 4000,
    });
    expect(out).toMatchObject({ discountCents: 400, pointsSpent: 100 });
    expect(db.member()!.currentPoints).toBe(30);
    expect(db.redemptions[0]).toMatchObject({ posSaleId: "s1", valueReceived: 400 });
  });

  it("refuses without enough points, spending nothing", async () => {
    const db = withReward();
    await db.service.enroll("t1", "c1", "staff");
    db.member()!.currentPoints = 99;
    await expect(
      db.service.redeemAtSale("t1", { clientId: "c1", rewardId: "rw1", saleId: "s1", items, subtotalCents: 4000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.member()!.currentPoints).toBe(99);
    expect(db.txs.filter((t) => t.type === "redeem")).toHaveLength(0);
  });

  it("a free-service reward pays for that service, and only if it is on the ticket", () => {
    const db = withReward();
    const reward = { type: "free_service", name: "Corte gratis", discountPercent: null, discountAmount: null, freeServiceId: "svc1" };
    expect(db.service.discountFor(reward, items, 4000)).toBe(4000);
    expect(() => db.service.discountFor({ ...reward, freeServiceId: "other" }, items, 4000)).toThrow(BadRequestException);
  });

  it("gives the points back when the sale fails, once", async () => {
    const db = withReward();
    await db.service.enroll("t1", "c1", "staff");
    db.member()!.currentPoints = 130;
    await db.service.redeemAtSale("t1", { clientId: "c1", rewardId: "rw1", saleId: "s1", items, subtotalCents: 4000 });
    await db.service.cancelSaleRedemption("t1", "s1", "Venta no completada");
    await db.service.cancelSaleRedemption("t1", "s1", "Venta no completada");
    expect(db.member()!.currentPoints).toBe(130);
    expect(db.redemptions[0].status).toBe("cancelled");
  });
});

/**
 * L1: a refund takes back only what the refunded row paid for, in
 * proportion. Every row of a till ticket used to carry all the ticket's
 * appointments, and refunding any of them reversed every visit whole.
 */
describe("LoyaltyService: a refund takes back only its share of what it paid for", () => {
  /** A ticket's row as the till writes it (pos.service.ts). */
  const row = (over: Row): any => ({
    tenantId: "t1",
    status: "refunded",
    type: "appointment",
    metadata: { posSaleId: "s1", appointmentIds: ["a1", "a2"] },
    ...over,
  });

  it("a shampoo refunded off a visit's ticket takes back the shampoo's points, never the visit's", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    // The visit (40,00) earns through itself; the shampoo (12,00) as the sale.
    db.appointments.push(paidVisit({ amountPaid: 4000, totalAmount: 4000, payments: [{ amount: 4000, method: "card" }] }));
    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 40 });
    expect(await db.service.earnForSale("t1", { clientId: "c1", saleId: "s1", basisCents: 1200, isVisit: false })).toBe(12);
    db.payments.push(row({ id: "pv", appointmentId: "a1", status: "paid" }));
    const shampoo = row({ id: "pp", type: "product", amount: 1200, metadata: { posSaleId: "s1", appointmentIds: ["a1"] } });
    db.payments.push(shampoo);

    await db.service.onPaymentRefunded("t1", shampoo, { id: "rf1", amount: 1200 });
    expect(db.member()!.currentPoints).toBe(40);
    expect(db.txs.filter((t) => t.type === "reversal")).toEqual([
      expect.objectContaining({ points: -12, source: "refund", sourceId: "rf1", metadata: expect.objectContaining({ posSaleId: "s1" }) }),
    ]);
  });

  it("card + cash: refunding the card takes back the card's half; the cash refund the rest, and the visit is then reversed", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(
      paidVisit({ amountPaid: 4000, totalAmount: 4000, payments: [{ amount: 2000, method: "card" }, { amount: 2000, method: "cash" }] }),
    );
    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 40 });
    const card = row({ id: "pc", appointmentId: "a1", amount: 2000 });
    const cash = row({ id: "pk", appointmentId: "a1", amount: 2000 });
    db.payments.push(card, { ...cash, status: "paid" });

    // The card's 20,00 back: the visit still has 20,00 paid, so it stays paid.
    db.appointments[0].amountPaid = 2000;
    await db.service.onPaymentRefunded("t1", card, { id: "rf-card", amount: 2000 });
    expect(db.member()!.currentPoints).toBe(20);
    expect(db.txs.some((t) => t.source === "appointment" && t.type === "reversal")).toBe(false);

    // The cash too: nothing left on the visit (refunded), the rest goes.
    db.appointments[0].amountPaid = 0;
    db.appointments[0].paymentStatus = "refunded";
    db.payments[1].status = "refunded";
    await db.service.onPaymentRefunded("t1", cash, { id: "rf-cash", amount: 2000 });
    expect(db.member()!.currentPoints).toBe(0);
    // And never more than it earned, whatever runs again.
    await db.service.onPaymentRefunded("t1", cash, { id: "rf-cash", amount: 2000 });
    await db.service.reverseAppointment("t1", "a1", "Devolución del pago de la cita");
    expect(db.txs.filter((t) => t.memberId === db.member()!.id).reduce((s, t) => s + t.points, 0)).toBe(0);
  });

  it("mother and daughter on one ticket: the daughter's refund never touches the mother's points", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "mum", "staff");
    await db.service.enroll("t1", "kid", "staff");
    db.appointments.push(paidVisit({ id: "a1", clientId: "mum", amountPaid: 3000, payments: [{ amount: 3000, method: "card" }] }));
    db.appointments.push(paidVisit({ id: "a2", clientId: "kid", amountPaid: 2500, payments: [{ amount: 2500, method: "card" }] }));
    await db.service.settleAppointment("t1", "a1");
    await db.service.settleAppointment("t1", "a2");
    expect([db.member("mum")!.currentPoints, db.member("kid")!.currentPoints]).toEqual([30, 25]);
    db.payments.push(row({ id: "pm", appointmentId: "a1", status: "paid" }));
    const kids = row({ id: "pd", appointmentId: "a2", amount: 2500 });
    db.payments.push(kids);
    db.appointments[1].paymentStatus = "refunded";
    db.appointments[1].amountPaid = 0;

    await db.service.onPaymentRefunded("t1", kids, { id: "rf-kid", amount: 2500 });
    expect(db.member("kid")!.currentPoints).toBe(0);
    expect(db.member("mum")!.currentPoints).toBe(30);
  });

  it("a partial refund then the rest: the later refund takes only what remains", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit({ amountPaid: 4500, totalAmount: 4500, payments: [{ amount: 4500, method: "card" }] }));
    await db.service.settleAppointment("t1", "a1");
    const pay = row({ id: "p1", appointmentId: "a1", amount: 4500, status: "paid" });
    // 15,00 of 45,00: 15 points, its own entry.
    expect(await db.service.onPartialRefund("t1", pay, { id: "r1", amount: 1500 })).toBe(-15);
    // The other 30,00, the payment now refunded in full: 30, its own entry, 45 in all.
    db.appointments[0].paymentStatus = "refunded";
    await db.service.onPaymentRefunded("t1", { ...pay, status: "refunded" }, { id: "r2", amount: 3000 });
    expect(db.member()!.currentPoints).toBe(0);
    expect(db.txs.filter((t) => t.source === "refund").map((t) => [t.sourceId, t.points])).toEqual([
      ["r1", -15],
      ["r2", -30],
    ]);
  });

  it("the payment that bought a gift card takes no points back (it earned none)", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    await db.service.earnForSale("t1", { clientId: "c1", saleId: "s1", basisCents: 3000, isVisit: true });
    db.payments.push(row({ id: "ps", type: "service", amount: 3000, status: "paid", metadata: { posSaleId: "s1" } }));
    const card = row({ id: "pg", type: "gift_card", amount: 5000, metadata: { posSaleId: "s1" } });
    await db.service.onPaymentRefunded("t1", card, { id: "rf-g", amount: 5000 });
    expect(db.member()!.currentPoints).toBe(30);
  });
});

/** L5: a visit earns once, on its whole money, when it is paid in full. */
describe("LoyaltyService: a visit earns once it is paid in full", () => {
  it("a first partial payment earns nothing; the visit earns on all its money when the rest is paid", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    // 20,00 of 50,00 paid: the till leaves it pending.
    db.appointments.push(
      paidVisit({ paymentStatus: "pending", amountPaid: 2000, totalAmount: 5000, payments: [{ amount: 2000, method: "card" }] }),
    );
    expect(await db.service.settleAppointment("t1", "a1")).toBeNull();
    expect(db.txs).toHaveLength(0);
    // The other 30,00: paid.
    db.appointments[0].paymentStatus = "paid";
    db.appointments[0].amountPaid = 5000;
    db.appointments[0].payments.push({ amount: 3000, method: "cash" });
    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 50 });
  });

  it("only the visit's own share of the reward comes off its basis", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    // A 15,00 reward: 10,00 on this visit (its record), 5,00 on a product of the ticket.
    db.appointments.push(
      paidVisit({ amountPaid: 4000, totalAmount: 4000, discount: { loyalty: { moneyCents: 1000 } }, payments: [{ amount: 3000, method: "card" }] }),
    );
    db.redemptions.push({ id: "r0", appointmentId: "a1", valueReceived: 1500, status: "completed" });
    expect(await db.service.settleAppointment("t1", "a1")).toEqual({ awarded: 30 });
  });
});

describe("LoyaltyService: levels never go down", () => {
  const oroVisit = (db: ReturnType<typeof fakeDb>) => {
    db.tiers.push({ id: "bronce", programId: "prog1", name: "Bronce", minPoints: 0 });
    db.tiers.push({ id: "oro", programId: "prog1", name: "Oro", minPoints: 50 });
    db.appointments.push(paidVisit({ amountPaid: 6000, totalAmount: 6000, payments: [{ amount: 6000, method: "card" }] }));
  };

  it("an earning raises the level; spending, a refund, a cancellation or a negative adjustment never lower it", async () => {
    const db = fakeDb();
    oroVisit(db);
    await db.service.enroll("t1", "c1", "staff");
    await db.service.settleAppointment("t1", "a1");
    expect(db.member()!.tierId).toBe("oro");
    expect(db.member()!.peakLifetimePoints).toBe(60);

    db.rewards.push({ id: "rw1", programId: "prog1", name: "Corte", type: "discount", discountPercent: 10, discountAmount: null, freeServiceId: null, pointsCost: 40, isActive: true, currentRedemptions: 0, maxRedemptions: null, expiresAt: null });
    await db.service.redeemAtSale("t1", { clientId: "c1", rewardId: "rw1", saleId: "s9", items: [], subtotalCents: 4000 });
    expect(db.member()!.tierId).toBe("oro");

    // 20,00 of the 60,00 refunded: 40 accumulated, below Oro: still Oro (#219 took it back).
    await db.service.onPartialRefund("t1", { id: "p1", appointmentId: "a1" }, { id: "r1", amount: 2000 });
    expect(db.member()!.lifetimePoints).toBe(40);
    expect(db.member()!.tierId).toBe("oro");
    // The whole visit reversed: 0 accumulated, and a negative balance. Still Oro.
    await db.service.reverseAppointment("t1", "a1", "Cita cancelada");
    expect(db.member()!.lifetimePoints).toBe(0);
    expect(db.member()!.currentPoints).toBe(-40);
    expect(db.member()!.tierId).toBe("oro");
    expect(db.member()!.peakLifetimePoints).toBe(60);
  });

  it("a level created later reaches the members it applies to at once, upwards only", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit({ amountPaid: 6000, totalAmount: 6000, payments: [{ amount: 6000, method: "card" }] }));
    await db.service.settleAppointment("t1", "a1");
    expect(db.member()!.tierId).toBeNull();
    // The visit is refunded: 0 accumulated now, but she reached 60 once.
    await db.service.reverseAppointment("t1", "a1", "Cita cancelada");

    await db.service.createTier("t1", { name: "Plata", minPoints: 30, pointsMultiplier: 1.2 });
    const plata = db.tiers.find((t) => t.name === "Plata")!;
    expect(db.member()!.tierId).toBe(plata.id);
    // A higher level she never reached: nothing changes.
    await db.service.createTier("t1", { name: "Oro", minPoints: 100, pointsMultiplier: 1.5 });
    expect(db.member()!.tierId).toBe(plata.id);
  });

  it("editing a level moves members up to it, never down", async () => {
    const db = fakeDb();
    oroVisit(db);
    await db.service.enroll("t1", "c1", "staff");
    await db.service.settleAppointment("t1", "a1");
    expect(db.member()!.tierId).toBe("oro");

    // A Platino she has not reached, then lowered to 60: she reached 60, so up she goes.
    await db.service.createTier("t1", { name: "Platino", minPoints: 1000, pointsMultiplier: 2 });
    const platino = db.tiers.find((t) => t.name === "Platino")!;
    expect(db.member()!.tierId).toBe("oro");
    await db.service.updateTier("t1", platino.id, { minPoints: 60 });
    expect(db.member()!.tierId).toBe(platino.id);
    // Platino now needs 500: she keeps it.
    await db.service.updateTier("t1", platino.id, { minPoints: 500 });
    expect(db.member()!.tierId).toBe(platino.id);
  });

  it("a member of a deleted level takes the highest one left within her reach", async () => {
    const db = fakeDb();
    oroVisit(db);
    await db.service.enroll("t1", "c1", "staff");
    await db.service.settleAppointment("t1", "a1");
    await db.service.deleteTier("t1", "oro");
    expect(db.member()!.tierId).toBe("bronce");
  });

  it("re-tiers a programme in batches", async () => {
    const db = fakeDb();
    for (let i = 0; i < 1200; i++) {
      db.members.push({ id: `m${String(i).padStart(5, "0")}`, programId: "prog1", clientId: `c${i}`, tierId: null, peakLifetimePoints: i % 2 ? 100 : 10, lifetimePoints: 0, currentPoints: 0 });
    }
    await db.service.createTier("t1", { name: "Plata", minPoints: 50, pointsMultiplier: 1.2 });
    const plata = db.tiers.find((t) => t.name === "Plata")!;
    expect(db.members.filter((m) => m.tierId === plata.id)).toHaveLength(600);
    expect(db.prisma.loyaltyMember.findMany.mock.calls.every((c: any[]) => c[0].take === 500)).toBe(true);
  });

  it("a second level with the same name is a 409 in Spanish, not a 500", async () => {
    const db = fakeDb();
    await db.service.createTier("t1", { name: "Oro", minPoints: 500, pointsMultiplier: 1.5 });
    const err = await db.service.createTier("t1", { name: "Oro", minPoints: 900, pointsMultiplier: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/Ya hay un nivel llamado «Oro»/);
  });
});

describe("LoyaltyService: rewards", () => {
  it("a discount needs exactly one of a percent or an amount above zero", async () => {
    const db = fakeDb();
    const base = { name: "Descuento", type: "discount" as const, pointsCost: 100 };
    await expect(db.service.createReward("t1", { ...base, discountPercent: 0, discountAmount: 0 })).rejects.toThrow(/porcentaje o un importe/);
    await expect(db.service.createReward("t1", { ...base, discountPercent: 10, discountAmount: 500 })).rejects.toThrow(/no los dos/);
    const ok = await db.service.createReward("t1", { ...base, discountPercent: 0, discountAmount: 500 });
    expect(ok).toMatchObject({ discountPercent: null, discountAmount: 500 });
  });

  it("is editable: cost, value, name, active, the limit and the expiry (null clears them)", async () => {
    const db = fakeDb();
    db.prisma.loyaltyReward.findFirst = jest.fn(async ({ where }: any) => db.rewards.find((r) => r.id === where.id) ?? null);
    const r = await db.service.createReward("t1", { name: "10 %", type: "discount", pointsCost: 100, discountPercent: 10, maxRedemptions: 5 });
    await db.service.updateReward("t1", r.id, {
      name: "5 € menos",
      pointsCost: 150,
      discountPercent: 0,
      discountAmount: 500,
      isActive: false,
      expiresAt: "2026-12-31T22:59:59.999Z",
    });
    expect(db.rewards[0]).toMatchObject({ name: "5 € menos", pointsCost: 150, discountPercent: null, discountAmount: 500, isActive: false, maxRedemptions: 5 });
    expect(db.rewards[0].expiresAt).toEqual(new Date("2026-12-31T22:59:59.999Z"));
    // A percent sent over a stored amount, with the amount still there: refused.
    await expect(db.service.updateReward("t1", r.id, { discountPercent: 10 })).rejects.toThrow(/no los dos/);
    await db.service.updateReward("t1", r.id, { maxRedemptions: null, expiresAt: null });
    expect(db.rewards[0]).toMatchObject({ maxRedemptions: null, expiresAt: null });
    // Not below what was redeemed.
    db.rewards[0].currentRedemptions = 3;
    await expect(db.service.updateReward("t1", r.id, { maxRedemptions: 2 })).rejects.toThrow(/3 veces/);
  });

  it("the last use of a limited reward goes to one till only, and a refused redemption gives its use back", async () => {
    const db = fakeDb();
    db.rewards.push({ id: "rw1", programId: "prog1", name: "Corte", type: "discount", discountPercent: 10, discountAmount: null, freeServiceId: null, pointsCost: 10, isActive: true, currentRedemptions: 0, maxRedemptions: 1, expiresAt: null });
    await db.service.enroll("t1", "c1", "staff");
    await db.service.enroll("t1", "c2", "staff");
    db.member("c1")!.currentPoints = 50;
    db.member("c2")!.currentPoints = 50;
    const redeem = (clientId: string, saleId: string) =>
      db.service.redeemAtSale("t1", { clientId, rewardId: "rw1", saleId, items: [], subtotalCents: 4000 });
    const out = await Promise.allSettled([redeem("c1", "s1"), redeem("c2", "s2")]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(db.rewards[0].currentRedemptions).toBe(1);
    // Claimed in one conditional write, not read-then-increment.
    expect(db.prisma.loyaltyReward.updateMany).toHaveBeenCalledWith({
      where: { id: "rw1", OR: [{ maxRedemptions: null }, { currentRedemptions: { lt: "maxRedemptions" } }] },
      data: { currentRedemptions: { increment: 1 } },
    });
    expect(db.member("c1")!.currentPoints + db.member("c2")!.currentPoints).toBe(90);

    // The points fall short after the claim: the use is given back.
    db.rewards[0].maxRedemptions = 5;
    db.prisma.loyaltyMember.update.mockImplementationOnce(async () => {
      throw new BadRequestException("Puntos insuficientes");
    });
    await expect(redeem("c1", "s3")).rejects.toThrow(/insuficientes/);
    expect(db.rewards[0].currentRedemptions).toBe(1);
  });
});

describe("LoyaltyService: a negative balance after earn, redeem, refund", () => {
  const discount = { programId: "prog1", type: "discount", discountPercent: 10, discountAmount: null, freeServiceId: null, isActive: true, currentRedemptions: 0, maxRedemptions: null, expiresAt: null };

  it("earn 45, spend 40, refund the visit: -40; she cannot redeem; her next visits pay it off", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit());
    await db.service.settleAppointment("t1", "a1");
    db.rewards.push({ ...discount, id: "rw1", name: "10 %", pointsCost: 40 });
    db.rewards.push({ ...discount, id: "rw0", name: "Casi nada", pointsCost: 1 });
    await db.service.redeemAtSale("t1", { clientId: "c1", rewardId: "rw1", saleId: "s1", items: [], subtotalCents: 4000 });
    expect(db.member()!.currentPoints).toBe(5);

    db.appointments[0].paymentStatus = "refunded";
    await db.service.onPaymentRefunded("t1", { id: "p1", amount: 4550, appointmentId: "a1" }, { id: "rf1", amount: 4550 });
    expect(db.member()!.currentPoints).toBe(-40);

    // Not even a 1-point reward.
    const err = await db.service
      .redeemAtSale("t1", { clientId: "c1", rewardId: "rw0", saleId: "s2", items: [], subtotalCents: 1000 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/saldo de puntos negativo \(-40\)/);
    expect(db.txs.some((t) => t.sourceId === "s2")).toBe(false);

    // 60 EUR later: +60, 20 left.
    db.appointments.push(paidVisit({ id: "a2", amountPaid: 6000, totalAmount: 6000, payments: [{ amount: 6000, method: "card" }] }));
    await db.service.settleAppointment("t1", "a2");
    expect(db.member()!.currentPoints).toBe(20);
  });

  it("only reversals go negative: a spend or a manual deduction beyond the balance still fails", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    await db.service.earnForSale("t1", { clientId: "c1", saleId: "s0", basisCents: 3000, isVisit: true });
    const err = await db.service.adjust("t1", db.member()!.id, { points: -31, reason: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(db.member()!.currentPoints).toBe(30);

    // Two tills spending at once: the post-write check refuses the second.
    db.rewards.push({ ...discount, id: "rw1", name: "10 %", pointsCost: 20 });
    const realUpdate = db.prisma.loyaltyMember.update;
    db.prisma.loyaltyMember.update = jest.fn(async (args: any) => {
      // The other till's spend lands between this one's check and its write.
      if (args.data?.currentPoints?.increment === -20 && db.member()!.currentPoints === 30) db.member()!.currentPoints -= 20;
      return realUpdate(args);
    });
    const raced = await db.service
      .redeemAtSale("t1", { clientId: "c1", rewardId: "rw1", saleId: "s1", items: [], subtotalCents: 1000 })
      .catch((e) => e);
    expect(raced).toBeInstanceOf(BadRequestException);
    expect(raced.message).toMatch(/Puntos insuficientes/);
  });

  it("the client's file and the till see no reward as redeemable with a negative balance", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.member()!.currentPoints = -10;
    db.prisma.loyaltyProgram.findFirst = jest.fn(async () => ({ ...db.program, rewards: [{ ...discount, id: "rw0", name: "Gratis", pointsCost: 0 }] }));
    db.prisma.loyaltyTransaction.findMany = jest.fn(async () => []);
    const summary = await db.service.clientSummary("t1", "c1");
    expect(summary.rewards[0].redeemable).toBe(false);
    expect(summary.member!.currentPoints).toBe(-10);
  });
});

describe("LoyaltyService: points expire after 12 months without a visit", () => {
  // 2027-06-15 10:00 in Madrid (UTC+2).
  const NOW = new Date("2027-06-15T08:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5);

  it("expires the whole balance of a member with no visit for 365 days, once per day, as «Caducidad»", async () => {
    const db = fakeDb({ program: { pointsExpirationDays: 365, pointsExpiryStartsAt: null } });
    await db.service.enroll("t1", "old", "staff");
    await db.service.enroll("t1", "recent", "staff");
    const old = db.member("old")!;
    const recent = db.member("recent")!;
    Object.assign(old, { currentPoints: 120, lifetimePoints: 300, peakLifetimePoints: 300, pointsRenewedAt: daysAgo(400) });
    Object.assign(recent, { currentPoints: 80, pointsRenewedAt: daysAgo(300) });

    expect(await db.service.expireInactivePoints(NOW)).toEqual({ members: 1, points: 120 });
    expect(old.currentPoints).toBe(0);
    // The points accumulated (the level) stay.
    expect(old.lifetimePoints).toBe(300);
    expect(recent.currentPoints).toBe(80);
    expect(db.txs.find((t) => t.type === "expire")).toMatchObject({
      memberId: old.id,
      points: -120,
      source: "expiry",
      sourceId: "2027-06-15",
      description: "Caducidad",
    });
    // The next tick the same day, or a second instance: nothing more.
    old.currentPoints = 10;
    expect(await db.service.expireInactivePoints(new Date(NOW.getTime() + 3600e3))).toEqual({ members: 0, points: 0 });
    expect(old.currentPoints).toBe(10);
  });

  it("does not run before 03:00 in the salon, nor for a negative or zero balance, nor without the plan", async () => {
    const db = fakeDb({ program: { pointsExpirationDays: 365, pointsExpiryStartsAt: null } });
    await db.service.enroll("t1", "c1", "staff");
    Object.assign(db.member()!, { currentPoints: 50, pointsRenewedAt: daysAgo(500) });
    // 02:30 in Madrid.
    expect(await db.service.expireInactivePoints(new Date("2027-06-15T00:30:00Z"))).toEqual({ members: 0, points: 0 });

    db.member()!.currentPoints = -20;
    expect(await db.service.expireInactivePoints(NOW)).toEqual({ members: 0, points: 0 });
    expect(db.member()!.currentPoints).toBe(-20);

    const locked = fakeDb({ program: { pointsExpirationDays: 365 }, unlocked: false });
    await locked.service.enroll("t1", "c1", "staff");
    Object.assign(locked.member()!, { currentPoints: 50, pointsRenewedAt: daysAgo(500) });
    expect(await locked.service.expireInactivePoints(NOW)).toEqual({ members: 0, points: 0 });
  });

  it("the grace: the programmes still in it are not asked for", async () => {
    const db = fakeDb({ program: { pointsExpirationDays: 365 } });
    await db.service.expireInactivePoints(NOW);
    expect(db.prisma.loyaltyProgram.findMany.mock.calls[0][0].where).toMatchObject({
      isActive: true,
      pointsExpirationDays: { not: null },
      OR: [{ pointsExpiryStartsAt: null }, { pointsExpiryStartsAt: { lte: NOW } }],
    });
  });

  it("a completed, paid visit renews all her points, from when the visit was", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    const visitAt = new Date(Date.now() - 2 * 864e5);
    db.member()!.pointsRenewedAt = new Date(Date.now() - 400 * 864e5);
    db.appointments.push(paidVisit({ completionTime: visitAt }));
    await db.service.settleAppointment("t1", "a1");
    expect(db.member()!.pointsRenewedAt).toEqual(visitAt);
    // An older visit settled late does not move it back.
    db.appointments.push(paidVisit({ id: "a0", completionTime: new Date(Date.now() - 30 * 864e5) }));
    await db.service.settleAppointment("t1", "a0");
    expect(db.member()!.pointsRenewedAt).toEqual(visitAt);
  });

  it("a visit paid in full with points (a free service) renews them too", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.member()!.pointsRenewedAt = new Date(Date.now() - 400 * 864e5);
    const visitAt = new Date(Date.now() - 3600e3);
    db.appointments.push(paidVisit({ payments: [], completionTime: visitAt }));
    expect(await db.service.settleAppointment("t1", "a1")).toBeNull();
    expect(db.member()!.pointsRenewedAt).toEqual(visitAt);
  });

  it("switching expiry on or shortening it gives 30 days of grace; lengthening it does not", async () => {
    const db = fakeDb({ program: { pointsExpirationDays: null, pointsExpiryStartsAt: null } });
    db.prisma.loyaltyProgram.upsert = jest.fn(async ({ update }: any) => Object.assign(db.program, update));
    db.prisma.loyaltyProgram.findFirst = jest.fn(async () => db.program);
    await db.service.saveProgram("t1", { pointsExpirationDays: 365 } as any);
    const grace = db.program.pointsExpiryStartsAt as Date;
    expect(grace.getTime()).toBeGreaterThan(Date.now() + 29 * 864e5);
    db.program.pointsExpiryStartsAt = null;
    await db.service.saveProgram("t1", { pointsExpirationDays: 730 } as any);
    expect(db.program.pointsExpiryStartsAt).toBeNull();
    await db.service.saveProgram("t1", { pointsExpirationDays: 180 } as any);
    expect(db.program.pointsExpiryStartsAt).not.toBeNull();
  });
});

describe("LoyaltyService: product rewards name their product", () => {
  it("a product reward needs a product of the salon", async () => {
    const db = fakeDb();
    db.prisma.product = { findFirst: jest.fn(async ({ where }: any) => (where.id === "prod1" && where.tenantId === "t1" ? { id: "prod1" } : null)) };
    const missing = await db.service.createReward("t1", { name: "Champú", type: "product", pointsCost: 100 } as any).catch((e) => e);
    expect(missing.message).toMatch(/Elige el producto/);
    const foreign = await db.service
      .createReward("t1", { name: "Champú", type: "product", pointsCost: 100, productId: "other" } as any)
      .catch((e) => e);
    expect(foreign.message).toMatch(/no es de este salón/);
    const ok = await db.service.createReward("t1", { name: "Champú", type: "product", pointsCost: 100, productId: "prod1" } as any);
    expect(ok.productId).toBe("prod1");
  });
});
