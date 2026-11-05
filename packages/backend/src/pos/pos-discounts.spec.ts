import "reflect-metadata";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";
import { PosSettingsDto } from "./dto/pos.dto";
import { PosController } from "./pos.controller";
import { allocateCents, applyDiscounts, assertDiscountAllowed, discountCents } from "./pos-discounts";

/**
 * Manual discounts at the till. Since #173 the till prices every line from
 * the database, so a discount is an explicit request the server turns into
 * cents and checks against who is at the till. These are the arithmetic,
 * the limits and the shape of the request.
 */

const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

describe("till discounts: the arithmetic", () => {
  it("takes a percentage off, rounding half up to the cent", () => {
    expect(discountCents({ type: "percentage", value: 10 }, 4000)).toBe(400);
    // 10 % of 19,99 EUR is 199,9 cents: 2,00 EUR.
    expect(discountCents({ type: "percentage", value: 10 }, 1999)).toBe(200);
    // 12,5 % of 10,01 EUR is 125,125 cents: 1,25 EUR.
    expect(discountCents({ type: "percentage", value: 12.5 }, 1001)).toBe(125);
    // Exactly half a cent goes up: 15 % of 0,05 EUR is 0,75 cents -> 1.
    expect(discountCents({ type: "percentage", value: 15 }, 5)).toBe(1);
    // 33,33 % of 3,00 EUR is 99,99 cents, exactly (integer arithmetic): 1,00 EUR.
    expect(discountCents({ type: "percentage", value: 33.33 }, 300)).toBe(100);
    expect(discountCents({ type: "percentage", value: 100 }, 2550)).toBe(2550);
    expect(discountCents({ type: "percentage", value: 0 }, 2550)).toBe(0);
  });

  it("takes a fixed amount off, never more than the base", () => {
    expect(discountCents({ type: "fixed", value: 500 }, 4000)).toBe(500);
    expect(discountCents({ type: "fixed", value: 4000 }, 4000)).toBe(4000);
    expect(() => discountCents({ type: "fixed", value: 4001 }, 4000)).toThrow(BadRequestException);
    expect(() => discountCents({ type: "fixed", value: 4001 }, 4000)).toThrow(/supera el importe de la línea \(40,00 €\)/);
  });

  it("refuses what the DTO refuses too, should it get past it", () => {
    expect(() => discountCents({ type: "percentage", value: 101 }, 4000)).toThrow(BadRequestException);
    expect(() => discountCents({ type: "percentage", value: -1 }, 4000)).toThrow(BadRequestException);
    expect(() => discountCents({ type: "fixed", value: 10.5 }, 4000)).toThrow(BadRequestException);
    expect(() => discountCents({ type: "other" as any, value: 1 }, 4000)).toThrow(BadRequestException);
  });

  it("shares cents in proportion, adding up exactly", () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(1000, [3000, 1000])).toEqual([750, 250]);
    expect(allocateCents(7, [0, 0])).toEqual([0, 0]);
    expect(allocateCents(0, [5, 5])).toEqual([0, 0]);
    const shares = allocateCents(997, [1234, 5678, 91, 3]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(997);
  });

  it("applies each line's discount, then the ticket's on what is left, shared over the lines", () => {
    const t = applyDiscounts(
      [
        { price: 4000, quantity: 1, discount: { type: "percentage" as const, value: 10 } },
        { price: 1250, quantity: 2 },
      ],
      { type: "fixed", value: 600 },
    );
    expect(t.subtotalCents).toBe(6500);
    expect(t.lineDiscountsCents).toBe(400);
    expect(t.orderBaseCents).toBe(6100);
    expect(t.orderDiscountCents).toBe(600);
    expect(t.discountCents).toBe(1000);
    expect(t.totalCents).toBe(5500);
    // 600 over 3600 and 2500, in proportion: 354 + 246.
    expect(t.lines.map((l) => [l.grossCents, l.lineDiscountCents, l.orderDiscountCents, l.netCents])).toEqual([
      [4000, 400, 354, 3246],
      [2500, 0, 246, 2254],
    ]);
    expect(t.lines.reduce((s, l) => s + l.netCents, 0)).toBe(t.totalCents);
  });

  it("caps a fixed ticket discount at the ticket after its line discounts", () => {
    expect(() =>
      applyDiscounts([{ price: 1000, quantity: 1, discount: { type: "fixed" as const, value: 500 } }], { type: "fixed", value: 501 }),
    ).toThrow("El descuento (5,01 €) supera el importe del ticket (5,00 €).");
    const t = applyDiscounts([{ price: 1000, quantity: 1, discount: { type: "fixed" as const, value: 500 } }], {
      type: "fixed",
      value: 500,
    });
    expect(t.totalCents).toBe(0);
  });

  it("is the plain ticket without discounts", () => {
    const t = applyDiscounts([{ price: 4000, quantity: 2 }]);
    expect(t).toMatchObject({ subtotalCents: 8000, discountCents: 0, totalCents: 8000 });
  });
});

describe("till discounts: who may give them", () => {
  const ticket = (lineSpec?: any, orderSpec?: any) =>
    applyDiscounts([{ price: 1999, quantity: 1, ...(lineSpec ? { discount: lineSpec } : {}) }, { price: 1000, quantity: 1 }], orderSpec);

  it("the owner and managers, always and any amount", () => {
    const t = ticket({ type: "percentage", value: 100 });
    expect(() => assertDiscountAllowed("owner", 0, t)).not.toThrow();
    expect(() => assertDiscountAllowed("admin", 0, t)).not.toThrow();
  });

  it("staff, not at all while the salon's limit is 0 (the default)", () => {
    const t = ticket({ type: "percentage", value: 5 });
    expect(() => assertDiscountAllowed("staff", 0, t)).toThrow(ForbiddenException);
    expect(() => assertDiscountAllowed("staff", 0, t)).toThrow("Solo la propietaria o un encargado pueden aplicar descuentos en caja.");
    // Nobody named (no actor) counts as staff.
    expect(() => assertDiscountAllowed(undefined, 0, t)).toThrow(ForbiddenException);
  });

  it("staff, up to the limit per line, on the rate asked for (10 % of 19,99 rounds to 2,00 and is still 10 %)", () => {
    expect(() => assertDiscountAllowed("staff", 10, ticket({ type: "percentage", value: 10 }))).not.toThrow();
    expect(() => assertDiscountAllowed("staff", 10, ticket({ type: "percentage", value: 10.01 }))).toThrow(
      "Tu límite de descuento es del 10 % por línea. Para descontar más, pide a un encargado que lo aplique.",
    );
    // A fixed amount counts as its share of the line: 1,99 of 19,99 is under 10 %, 2,00 is over.
    expect(() => assertDiscountAllowed("staff", 10, ticket({ type: "fixed", value: 199 }))).not.toThrow();
    expect(() => assertDiscountAllowed("staff", 10, ticket({ type: "fixed", value: 200 }))).toThrow(ForbiddenException);
  });

  it("staff cannot stack a line discount and a ticket discount past the limit", () => {
    expect(() => assertDiscountAllowed("staff", 10, ticket(undefined, { type: "percentage", value: 10 }))).not.toThrow();
    expect(() =>
      assertDiscountAllowed("staff", 10, ticket({ type: "percentage", value: 10 }, { type: "percentage", value: 10 }), {
        type: "percentage",
        value: 10,
      }),
    ).toThrow(ForbiddenException);
    // 5 % then 5 % is 9,75 %: within 10 %.
    const order = { type: "percentage" as const, value: 5 };
    expect(() => assertDiscountAllowed("staff", 10, ticket({ type: "percentage", value: 5 }, order), order)).not.toThrow();
  });

  it("a ticket with no discount needs no permission", () => {
    expect(() => assertDiscountAllowed("staff", 0, ticket())).not.toThrow();
    expect(() => assertDiscountAllowed("staff", 0, ticket({ type: "percentage", value: 0 }))).not.toThrow();
  });
});

describe("till discounts: the request", () => {
  const parse = bodyParser(PosController, "checkout");
  const base = {
    clientId: uuid(1),
    items: [{ serviceId: uuid(3), quantity: 1 }],
    payments: [{ method: "cash", amount: 3600 }],
  };

  it("takes a type, a value and a reason, on a line and on the ticket", async () => {
    const out = await parse({
      ...base,
      items: [{ serviceId: uuid(3), quantity: 1, discount: { type: "percentage", value: 12.5, reason: "Clienta habitual" } }],
      discount: { type: "fixed", value: 500, reason: "" },
    });
    expect(out.items[0].discount).toEqual({ type: "percentage", value: 12.5, reason: "Clienta habitual" });
    expect(out.discount).toEqual({ type: "fixed", value: 500 });
  });

  it("drops any amount the client tries to set: prices, totals, discount cents", async () => {
    const out = await parse({
      ...base,
      items: [
        {
          serviceId: uuid(3),
          quantity: 1,
          price: 1,
          total: 1,
          discount: { type: "percentage", value: 10, amountCents: 99999, netCents: 1 },
        },
      ],
      subtotal: 1,
      total: 1,
      discount: { type: "fixed", value: 100, amountCents: 99999 },
    });
    expect(out.items[0]).toEqual({ serviceId: uuid(3), quantity: 1, discount: { type: "percentage", value: 10 } });
    expect(out.subtotal).toBeUndefined();
    expect(out.total).toBeUndefined();
    expect(out.discount).toEqual({ type: "fixed", value: 100 });
  });

  it("refuses bad discounts", async () => {
    const withLine = (discount: unknown) => parse({ ...base, items: [{ serviceId: uuid(3), quantity: 1, discount }] });
    await expect(withLine({ type: "percentage", value: 101 })).rejects.toBeDefined();
    await expect(withLine({ type: "percentage", value: -5 })).rejects.toBeDefined();
    await expect(withLine({ type: "percentage", value: 10.555 })).rejects.toBeDefined();
    await expect(withLine({ type: "fixed", value: 5.5 })).rejects.toBeDefined();
    await expect(withLine({ type: "fixed", value: -100 })).rejects.toBeDefined();
    await expect(withLine({ type: "price", value: 100 })).rejects.toBeDefined();
    await expect(withLine({ type: "fixed" })).rejects.toBeDefined();
    await expect(withLine({ type: "fixed", value: 100, reason: "x".repeat(121) })).rejects.toBeDefined();
    await expect(parse({ ...base, discount: { type: "percentage", value: 150 } })).rejects.toBeDefined();
    // 120 characters is fine; 0 and 100 % too.
    await expect(withLine({ type: "fixed", value: 100, reason: "x".repeat(120) })).resolves.toBeDefined();
    await expect(withLine({ type: "percentage", value: 0 })).resolves.toBeDefined();
    await expect(withLine({ type: "percentage", value: 100 })).resolves.toBeDefined();
  });
});

describe("till settings: the staff discount limit", () => {
  it("is a whole percent from 0 to 100", async () => {
    expect(bodyMetatype(PosController, "updateSettings")).toBe(PosSettingsDto);
    const parse = bodyParser(PosController, "updateSettings");
    expect(await parse({ maxStaffDiscountPercent: 15, tenantId: uuid(1) })).toEqual({ maxStaffDiscountPercent: 15 });
    expect(await parse({ maxStaffDiscountPercent: "20" })).toEqual({ maxStaffDiscountPercent: 20 });
    await expect(parse({ maxStaffDiscountPercent: 101 })).rejects.toBeDefined();
    await expect(parse({ maxStaffDiscountPercent: -1 })).rejects.toBeDefined();
    await expect(parse({ maxStaffDiscountPercent: 7.5 })).rejects.toBeDefined();
    await expect(parse({})).rejects.toBeDefined();
  });

  it("is changed by the owner and managers only; everyone at the till can read it", () => {
    expect(Reflect.getMetadata(ROLES_KEY, PosController.prototype.updateSettings)).toEqual(["owner", "admin"]);
    expect(Reflect.getMetadata(ROLES_KEY, PosController.prototype.getSettings)).toEqual(["owner", "admin", "staff"]);
  });
});
