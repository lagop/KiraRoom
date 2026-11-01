import { checkedBreakdown, discrepancyCents, expectedCashCents, sessionFigures, type SessionInput } from "./cash-session-math";

/**
 * What the drawer should hold at close (arqueo), in cents: the float, the
 * cash kept from sales (already net of the change given back), cash
 * refunds, and money put in or taken out.
 */
const sale = (totalCents: number, changeCents = 0, over: Partial<SessionInput["sales"][number]> = {}) => ({
  totalCents,
  subtotalCents: totalCents,
  discountCents: 0,
  loyaltyDiscountCents: 0,
  changeCents,
  ...over,
});

const base = (over: Partial<SessionInput> = {}): SessionInput => ({
  openingFloatCents: 10_000,
  payments: [],
  refunds: [],
  sales: [],
  taxCents: 0,
  movements: [],
  ...over,
});

describe("expected cash", () => {
  it("an untouched drawer holds its float", () => {
    expect(sessionFigures(base()).cash.expectedCents).toBe(10_000);
  });

  it("float + cash sales: a 40 € ticket paid with 50 € is 40 € kept and 10 € change", () => {
    // pos-tenders.ts records the cash payment net of change: 4000.
    const f = sessionFigures(base({ payments: [{ method: "cash", amount: 4000 }], sales: [sale(4000, 1000)] }));
    expect(f.cash).toMatchObject({
      openingFloatCents: 10_000,
      salesCents: 4000,
      changeGivenCents: 1000,
      tenderedCents: 5000,
      expectedCents: 14_000,
    });
  });

  it("card, Bizum, wallet and gift card do not go into the drawer", () => {
    const f = sessionFigures(
      base({
        payments: [
          { method: "card", amount: 2500 },
          { method: "bizum", amount: 1800 },
          { method: "wallet", amount: 900 },
          { method: "gift_card", amount: 3000 },
        ],
      }),
    );
    expect(f.cash.expectedCents).toBe(10_000);
    expect(f.byMethod.map((m) => [m.method, m.amountCents])).toEqual([
      ["card", 2500],
      ["bizum", 1800],
      ["wallet", 900],
      ["gift_card", 3000],
    ]);
  });

  it("a mixed payment: only its cash part counts (30 € card + 20 € cash of a 50 € ticket, 50 € note given for the cash)", () => {
    // Tendered: card 3000 + cash 5000 on a 5000 ticket -> change 3000, cash kept 2000.
    const f = sessionFigures(
      base({
        payments: [
          { method: "card", amount: 3000 },
          { method: "cash", amount: 2000 },
        ],
        sales: [sale(5000, 3000)],
      }),
    );
    expect(f.cash).toMatchObject({ salesCents: 2000, changeGivenCents: 3000, tenderedCents: 5000, expectedCents: 12_000 });
    expect(f.sales).toMatchObject({ count: 1, grossCents: 5000 });
  });

  it("cash refunds come out of the drawer; card refunds do not", () => {
    const f = sessionFigures(
      base({
        payments: [
          { method: "cash", amount: 4000 },
          { method: "card", amount: 6000 },
        ],
        refunds: [
          { method: "cash", amount: 1500 },
          { method: "card", amount: 6000 },
        ],
      }),
    );
    expect(f.cash.refundsCents).toBe(1500);
    expect(f.cash.expectedCents).toBe(10_000 + 4000 - 1500);
    expect(f.refunds).toEqual({ count: 2, totalCents: 7500 });
    expect(f.byMethod.find((m) => m.method === "card")).toMatchObject({ amountCents: 6000, refundedCents: 6000, netCents: 0 });
    expect(f.byMethod.find((m) => m.method === "cash")).toMatchObject({ amountCents: 4000, refundedCents: 1500, netCents: 2500 });
  });

  it("money put in and taken out (change added, a supplier paid, takings to the bank)", () => {
    const f = sessionFigures(
      base({
        payments: [{ method: "cash", amount: 20_000 }],
        movements: [
          { type: "in", amountCents: 5000 },
          { type: "out", amountCents: 3500 },
          { type: "out", amountCents: 15_000 },
        ],
      }),
    );
    expect(f.cash).toMatchObject({ movementsInCents: 5000, movementsOutCents: 18_500, expectedCents: 10_000 + 20_000 + 5000 - 18_500 });
  });

  it("everything together", () => {
    expect(
      expectedCashCents({
        openingFloatCents: 15_000,
        cashSalesCents: 32_550,
        cashRefundsCents: 2000,
        movementsInCents: 1000,
        movementsOutCents: 20_000,
      }),
    ).toBe(26_550);
  });

  it("the report: sales, discounts, gross and tax", () => {
    const f = sessionFigures(
      base({
        payments: [{ method: "card", amount: 9000 }],
        sales: [sale(5000, 0, { subtotalCents: 6000, discountCents: 1000 }), sale(4000, 0, { subtotalCents: 4500, loyaltyDiscountCents: 500 })],
        taxCents: 1562,
      }),
    );
    expect(f.sales).toEqual({
      count: 2,
      grossCents: 9000,
      subtotalCents: 10_500,
      discountCents: 1000,
      loyaltyDiscountCents: 500,
      taxCents: 1562,
      netCents: 7438,
    });
  });
});

describe("discrepancy", () => {
  it("counted - expected: negative is missing, positive is over, 0 is square", () => {
    expect(discrepancyCents(13_500, 14_000)).toBe(-500);
    expect(discrepancyCents(14_200, 14_000)).toBe(200);
    expect(discrepancyCents(14_000, 14_000)).toBe(0);
  });
});

describe("count by coin and note", () => {
  it("keeps the pieces counted and checks they add up", () => {
    expect(checkedBreakdown({ "5000": 2, "200": 3, "10": 0 }, 10_600)).toEqual({ "5000": 2, "200": 3 });
    expect(checkedBreakdown(undefined, 500)).toBeNull();
  });

  it("refuses an unknown denomination, a bad count or a sum that is not the count", () => {
    expect(() => checkedBreakdown({ "300": 1 }, 300)).toThrow(/no es una moneda/);
    expect(() => checkedBreakdown({ "100": -1 }, 0)).toThrow(/entero/);
    expect(() => checkedBreakdown({ "100": 1.5 }, 150)).toThrow(/entero/);
    expect(() => checkedBreakdown({ "5000": 1 }, 4000)).toThrow(/no suma/);
  });
});

describe("wallet top-ups", () => {
  it("a cash top-up goes into the drawer; card and Bizum ones show by method; none is a sale", () => {
    const f = sessionFigures(
      base({
        payments: [{ method: "cash", amount: 4000 }],
        sales: [sale(4000)],
        walletTopUps: [
          { method: "cash", amount: 5000 },
          { method: "card", amount: 3000 },
          { method: "bizum", amount: 2000 },
        ],
      }),
    );
    // 100 float + 40 sale + 50 top-up.
    expect(f.cash).toMatchObject({ salesCents: 4000, walletTopUpsCents: 5000, tenderedCents: 4000, expectedCents: 19_000 });
    expect(f.byMethod.map((m) => [m.method, m.count, m.amountCents, m.topUpCents, m.netCents])).toEqual([
      ["cash", 2, 9000, 5000, 9000],
      ["card", 1, 3000, 3000, 3000],
      ["bizum", 1, 2000, 2000, 2000],
    ]);
    expect(f.walletTopUps).toEqual({ count: 3, totalCents: 10_000 });
    expect(f.sales).toMatchObject({ count: 1, grossCents: 4000 });
  });

  it("none: the figures are as before", () => {
    const f = sessionFigures(base({ payments: [{ method: "card", amount: 1000 }] }));
    expect(f.cash.walletTopUpsCents).toBe(0);
    expect(f.walletTopUps).toEqual({ count: 0, totalCents: 0 });
    expect(f.byMethod[0]).toMatchObject({ topUpCents: 0 });
  });

  it("expectedCashCents counts cash top-ups in", () => {
    const input = { openingFloatCents: 1000, cashSalesCents: 500, cashRefundsCents: 200, movementsInCents: 0, movementsOutCents: 100 };
    expect(expectedCashCents(input)).toBe(1200);
    expect(expectedCashCents({ ...input, cashWalletTopUpsCents: 2500 })).toBe(3700);
  });
});
