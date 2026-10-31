import { CommissionsController } from "./commissions.controller";
import { CalculateCommissionBodyDto, PayCommissionDto } from "./dto/commission.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

describe("POST /commissions/pay/:professionalId body", () => {
  const parse = bodyParser(CommissionsController, "payCommission");

  it("is the validated class, not an interface", () => {
    expect(bodyMetatype(CommissionsController, "payCommission")).toBe(PayCommissionDto);
  });

  it("keeps what the panel sends (empty ids, a date range)", async () => {
    const out = await parse({ appointmentIds: [], startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(out.appointmentIds).toEqual([]);
    expect(out.startDate).toEqual(new Date("2026-10-01"));
    expect(out.endDate).toEqual(new Date("2026-10-31"));
  });

  it("drops the professional and other keys the body may not set", async () => {
    const out = await parse({ professionalId: uuid(1), tenantId: uuid(2), commissionPaid: false });
    expect(Object.keys(out)).toEqual([]);
  });

  it("refuses Prisma filters where ids or dates go", async () => {
    await expect(parse({ appointmentIds: { not: "" } })).rejects.toBeDefined();
    await expect(parse({ appointmentIds: [{ not: "" }] })).rejects.toBeDefined();
    await expect(parse({ startDate: { lt: "2100-01-01" } })).rejects.toBeDefined();
    await expect(parse({ endDate: "not a date" })).rejects.toBeDefined();
  });
});

describe("POST /commissions/calculate/:appointmentId body", () => {
  const parse = bodyParser(CommissionsController, "calculateCommission");

  it("is the validated class", () => {
    expect(bodyMetatype(CommissionsController, "calculateCommission")).toBe(CalculateCommissionBodyDto);
  });

  it("accepts the overrides and a Decimal sent back as a string", async () => {
    expect(await parse({ amount: 45.5, rate: 40 })).toEqual({ amount: 45.5, rate: 40 });
    expect((await parse({ rate: "12.5" })).rate).toBe(12.5);
    expect(await parse({})).toEqual({});
  });

  it("refuses rates outside 0-100 and negative amounts", async () => {
    await expect(parse({ rate: 900 })).rejects.toBeDefined();
    await expect(parse({ rate: -5 })).rejects.toBeDefined();
    await expect(parse({ amount: -1 })).rejects.toBeDefined();
    await expect(parse({ amount: "abc" })).rejects.toBeDefined();
  });
});
