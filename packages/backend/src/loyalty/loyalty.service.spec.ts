import { BadRequestException } from "@nestjs/common";
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

  const prisma: any = {
    loyaltyProgram: {
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
          ...data,
        };
        members.push(m);
        return m;
      }),
      update: jest.fn(async ({ where, data }: any) => inc(members.find((m) => m.id === where.id)!, data)),
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
    loyaltyTier: { findFirst: jest.fn(async () => null) },
    loyaltyReward: {
      findFirst: jest.fn(async ({ where }: any) => rewards.find((r) => r.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => inc(rewards.find((r) => r.id === where.id)!, data)),
      updateMany: jest.fn(async () => ({ count: 1 })),
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
  return { service, prisma, program, members, txs, appointments, redemptions, rewards, payments, member };
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
    payments: [],
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
    expect(await db.service.settleAppointment("t1", "a1")).toBeNull();
    expect(db.txs).toHaveLength(0);
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
  it("a cancelled appointment gives its points back once, and never below zero", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    db.appointments.push(paidVisit());
    await db.service.settleAppointment("t1", "a1");
    // The client already spent 30 of the 45 points.
    db.member()!.currentPoints = 15;

    expect(await db.service.reverseAppointment("t1", "a1", "Cita cancelada")).toBe(-15);
    expect(await db.service.reverseAppointment("t1", "a1", "Cita cancelada")).toBe(0);
    expect(db.member()!.currentPoints).toBe(0);
  });

  it("a refunded till payment takes back its share of the sale", async () => {
    const db = fakeDb();
    await db.service.enroll("t1", "c1", "staff");
    // 60 EUR ticket paid half cash, half card.
    expect(await db.service.earnForSale("t1", { clientId: "c1", saleId: "s1", basisCents: 6000, isVisit: true })).toBe(60);
    db.payments.push({ id: "p1", tenantId: "t1", status: "paid", metadata: { posSaleId: "s1" } });
    db.payments.push({ id: "p2", tenantId: "t1", status: "refunded", metadata: { posSaleId: "s1" } });

    await db.service.onPaymentRefunded("t1", { id: "p2", amount: 3000, metadata: { posSaleId: "s1" } });
    await db.service.onPaymentRefunded("t1", { id: "p2", amount: 3000, metadata: { posSaleId: "s1" } });
    expect(db.member()!.currentPoints).toBe(30);
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

describe("LoyaltyService: client portal", () => {
  it("says the programme is off instead of failing", async () => {
    const db = fakeDb({ program: { isActive: false } });
    expect(await db.service.portalView("t1", "c1")).toEqual({ enabled: false });
  });

  it("refuses self-enrolment when the salon signs members up at the desk", async () => {
    const db = fakeDb({ program: { allowSelfEnroll: false } });
    await expect(db.service.portalJoin("t1", "c1")).rejects.toThrow(/mostrador/);
  });

  it("lets a client join and gives the welcome points once", async () => {
    const db = fakeDb({ program: { welcomePoints: 25 } });
    db.prisma.loyaltyReward.findMany = jest.fn(async () => []);
    await db.service.portalJoin("t1", "c1");
    await db.service.portalJoin("t1", "c1");
    expect(db.members).toHaveLength(1);
    expect(db.member()).toMatchObject({ enrolledVia: "portal", currentPoints: 25 });
  });
});
