import { giftOf } from "./loyalty.service";
import { expiryRuleText, expiryRun, graceAfterChange } from "./loyalty-expiry";
import { reviewEmailPoints, saleLoyaltyBlock } from "./loyalty-client-points";

describe("giftOf: what a reward hands over at the desk", () => {
  it("a product with its product; a product without one, or a voucher, is «otro regalo»; a discount nothing", () => {
    expect(giftOf({ type: "product", name: "Champú", productId: "p1" })).toEqual({
      kind: "product",
      productId: "p1",
      description: "Champú",
    });
    expect(giftOf({ type: "product", name: "Champú", productId: null })).toEqual({
      kind: "other",
      productId: null,
      description: "Champú",
    });
    expect(giftOf({ type: "voucher", name: "Regalo", description: "Neceser de viaje" })).toEqual({
      kind: "other",
      productId: null,
      description: "Neceser de viaje",
    });
    expect(giftOf({ type: "discount", name: "10 %" })).toBeNull();
    expect(giftOf({ type: "free_service", name: "Corte" })).toBeNull();
  });
});

describe("the expiry rule", () => {
  it("reads in months for 365-day and 30-day multiples", () => {
    expect(expiryRuleText(365)).toBe("Tus puntos caducan si pasan 12 meses sin visitas");
    expect(expiryRuleText(730)).toBe("Tus puntos caducan si pasan 24 meses sin visitas");
    expect(expiryRuleText(180)).toBe("Tus puntos caducan si pasan 6 meses sin visitas");
    expect(expiryRuleText(45)).toBe("Tus puntos caducan si pasan 45 días sin visitas");
    expect(expiryRuleText(null)).toBeNull();
  });

  it("runs from 03:00 in the salon, with the cutoff at the start of its day less the period", () => {
    // 02:59 in Madrid (summer, UTC+2): not yet.
    expect(expiryRun(new Date("2027-06-15T00:59:00Z"), "Europe/Madrid", 365)).toBeNull();
    const run = expiryRun(new Date("2027-06-15T01:00:00Z"), "Europe/Madrid", 365)!;
    expect(run.day).toBe("2027-06-15");
    // Midnight in Madrid on 2027-06-15 is 22:00 UTC on the 14th; less 365 days.
    expect(run.cutoff.toISOString()).toBe("2026-06-14T22:00:00.000Z");
    // Every tick of that day agrees.
    expect(expiryRun(new Date("2027-06-15T20:00:00Z"), "Europe/Madrid", 365)!.cutoff).toEqual(run.cutoff);
    // Canarias is an hour behind: 02:30 there.
    expect(expiryRun(new Date("2027-06-15T01:30:00Z"), "Atlantic/Canary", 365)).toBeNull();
  });

  it("grace: switching on or shortening gives 30 days; lengthening or switching off nothing", () => {
    const now = new Date("2027-01-01T00:00:00Z");
    const in30 = new Date("2027-01-31T00:00:00Z");
    expect(graceAfterChange({ pointsExpirationDays: null, pointsExpiryStartsAt: null }, 365, now)).toEqual(in30);
    expect(graceAfterChange({ pointsExpirationDays: 365, pointsExpiryStartsAt: null }, 180, now)).toEqual(in30);
    expect(graceAfterChange({ pointsExpirationDays: 365, pointsExpiryStartsAt: null }, 730, now)).toBeUndefined();
    expect(graceAfterChange({ pointsExpirationDays: 365, pointsExpiryStartsAt: null }, null, now)).toBeUndefined();
    expect(graceAfterChange({ pointsExpirationDays: 365, pointsExpiryStartsAt: null }, undefined, now)).toBeUndefined();
    // A longer grace already running is kept.
    const later = new Date("2027-03-01T00:00:00Z");
    expect(graceAfterChange({ pointsExpirationDays: 365, pointsExpiryStartsAt: later }, 180, now)).toEqual(later);
  });
});

describe("what the client is told about her points", () => {
  const db = (over: { program?: any; member?: any; earns?: number[] } = {}) => ({
    loyaltyProgram: {
      findFirst: jest.fn(async () =>
        over.program === null
          ? null
          : { id: "prog1", isActive: true, pointsExpirationDays: 365, showPointsInReviewEmail: true, ...over.program },
      ),
    },
    loyaltyMember: {
      findUnique: jest.fn(async () =>
        over.member === null ? null : { id: "m1", currentPoints: 140, status: "active", ...over.member },
      ),
    },
    loyaltyTransaction: { findMany: jest.fn(async () => (over.earns ?? [30, 15]).map((points) => ({ points }))) },
  });

  it("the receipt: points earned on the sale (its own and her visits), the balance and the rule", async () => {
    const d = db();
    expect(await saleLoyaltyBlock(d, "t1", { saleId: "s1", clientId: "c1", appointmentIds: ["a1"] })).toEqual({
      pointsEarned: 45,
      balance: 140,
      expiryRule: "Tus puntos caducan si pasan 12 meses sin visitas",
    });
    const where = (d.loyaltyTransaction.findMany.mock.calls[0] as any[])[0].where;
    expect(where).toMatchObject({ memberId: "m1", type: "earn" });
    expect(where.OR).toEqual([
      { source: "pos_sale", sourceId: "s1" },
      { source: "appointment", sourceId: { in: ["a1"] } },
    ]);
  });

  it("the receipt shows a negative balance as it is", async () => {
    const out = await saleLoyaltyBlock(db({ member: { currentPoints: -25 }, earns: [] }), "t1", {
      saleId: "s1",
      clientId: "c1",
      appointmentIds: [],
    });
    expect(out).toMatchObject({ pointsEarned: 0, balance: -25 });
  });

  it("the receipt: nothing without a client, a member, an active programme or the plan", async () => {
    const sale = { saleId: "s1", clientId: "c1", appointmentIds: [] as string[] };
    expect(await saleLoyaltyBlock(db(), "t1", { ...sale, clientId: null })).toBeNull();
    expect(await saleLoyaltyBlock(db({ member: null }), "t1", sale)).toBeNull();
    expect(await saleLoyaltyBlock(db({ program: null }), "t1", sale)).toBeNull();
    expect(await saleLoyaltyBlock(db(), "t1", sale, async () => false)).toBeNull();
  });

  it("the post-visit email: her balance when the setting is on (the default) and she has points", async () => {
    expect(await reviewEmailPoints(db(), "t1", "c1")).toEqual({
      balance: 140,
      expiryRule: "Tus puntos caducan si pasan 12 meses sin visitas",
    });
    expect(await reviewEmailPoints(db({ program: { showPointsInReviewEmail: false } }), "t1", "c1")).toBeNull();
    expect(await reviewEmailPoints(db({ member: { currentPoints: 0 } }), "t1", "c1")).toBeNull();
    expect(await reviewEmailPoints(db({ member: { currentPoints: -10 } }), "t1", "c1")).toBeNull();
    expect(await reviewEmailPoints(db({ member: { status: "inactive" } }), "t1", "c1")).toBeNull();
    expect(await reviewEmailPoints(db({ member: null }), "t1", "c1")).toBeNull();
    expect(await reviewEmailPoints(db({ program: null }), "t1", "c1")).toBeNull();
    expect(await reviewEmailPoints(db(), "t1", "c1", async () => false)).toBeNull();
  });
});
