import { BadRequestException } from "@nestjs/common";
import {
  linesPaidBy,
  refundableLines,
  requestedLines,
  shareOverLines,
  unitsValueCents,
  type SaleLineForRefund,
} from "./refund-lines";

/** Which lines of a till sale a refund gives back, and how its money is shared over them. */
const line = (over: Partial<SaleLineForRefund> & { id: string }): SaleLineForRefund => ({
  kind: "product",
  productId: "prod-1",
  appointmentId: null,
  description: "Champú",
  quantity: 3,
  totalCents: 1000,
  refundedQuantity: 0,
  refundedCents: 0,
  ...over,
});

describe("what units are worth", () => {
  it("their share of the line; the last units take all that is left (no cent lost or given twice)", () => {
    const l = line({ id: "l1" }); // 3 units for 10,00: 3,33 + 3,33 + 3,34
    expect(unitsValueCents(l, 1)).toBe(333);
    expect(unitsValueCents({ ...l, refundedQuantity: 1, refundedCents: 333 }, 1)).toBe(333);
    expect(unitsValueCents({ ...l, refundedQuantity: 2, refundedCents: 666 }, 1)).toBe(334);
    expect(unitsValueCents(l, 3)).toBe(1000);
  });

  it("never more than is left of the line in money (an amount was refunded already)", () => {
    expect(unitsValueCents(line({ id: "l1", refundedCents: 900 }), 1)).toBe(100);
  });
});

describe("the lines asked for", () => {
  const sale = [
    line({ id: "p1" }),
    line({ id: "s1", kind: "service", productId: null, description: "Corte", quantity: 1, totalCents: 3000 }),
    line({ id: "a1", kind: "appointment", productId: null, appointmentId: "apt-1", description: "Mechas", quantity: 1 }),
    line({ id: "g1", kind: "gift_card", productId: null, description: "Tarjeta regalo", quantity: 1 }),
  ];

  it("returns the units and their value", () => {
    expect(requestedLines(sale, [{ lineId: "p1", quantity: 2 }, { lineId: "s1", quantity: 1 }]).map((r) => [r.line.id, r.quantity, r.valueCents])).toEqual([
      ["p1", 2, 667],
      ["s1", 1, 3000],
    ]);
  });

  it("refuses, in Spanish: another sale's line, a repeated one, an appointment, a gift card, too many units", () => {
    const refuse = (requests: any[], message: RegExp) => {
      expect(() => requestedLines(sale, requests)).toThrow(BadRequestException);
      expect(() => requestedLines(sale, requests)).toThrow(message);
    };
    refuse([{ lineId: "other", quantity: 1 }], /no es de esta venta/);
    refuse([{ lineId: "p1", quantity: 1 }, { lineId: "p1", quantity: 1 }], /repetida/);
    refuse([{ lineId: "a1", quantity: 1 }], /es una cita/);
    refuse([{ lineId: "g1", quantity: 1 }], /tarjeta regalo/);
    refuse([{ lineId: "p1", quantity: 4 }], /solo quedan 3/);
    refuse([{ lineId: "p1", quantity: 0 }], /cuántas unidades/);
    expect(() => requestedLines([{ ...sale[0], refundedQuantity: 3, refundedCents: 1000 }], [{ lineId: "p1", quantity: 1 }])).toThrow(
      /ya está devuelta entera/,
    );
  });

  it("the dialog lists only what the till sold itself, with what is left of each", () => {
    const listed = refundableLines([{ ...sale[0], refundedQuantity: 1, refundedCents: 333 }, ...sale.slice(1)]);
    expect(listed.map((l) => l.id)).toEqual(["p1", "s1"]);
    expect(listed[0]).toMatchObject({ refundableQuantity: 2, refundableCents: 667 });
  });
});

describe("an amount over the lines", () => {
  const sale = [
    line({ id: "p1", totalCents: 1000 }),
    line({ id: "p2", productId: "prod-2", totalCents: 3000, quantity: 1 }),
    line({ id: "s1", kind: "service", productId: null, totalCents: 2000, quantity: 1 }),
  ];

  it("an amount with no lines goes over the lines of the payment's kind, in proportion to what is left", () => {
    const products = linesPaidBy("product", sale);
    expect(products.map((l) => l.id)).toEqual(["p1", "p2"]);
    expect(shareOverLines(1000, products, products.map((l) => l.totalCents))).toEqual([250, 750]);
    expect(linesPaidBy("service", sale).map((l) => l.id)).toEqual(["s1"]);
  });

  it("a payment of no kind of line left (or another type): every line with something left", () => {
    const spent = sale.map((l) => (l.kind === "service" ? { ...l, refundedCents: l.totalCents } : l));
    expect(linesPaidBy("service", spent).map((l) => l.id)).toEqual(["p1", "p2"]);
  });

  it("never more than is left of a line", () => {
    const partly = [{ ...sale[0], refundedCents: 900 }, sale[1]];
    expect(shareOverLines(1000, partly, [1, 1])).toEqual([100, 900]);
  });
});
