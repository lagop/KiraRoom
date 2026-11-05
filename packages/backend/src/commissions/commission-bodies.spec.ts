import { CommissionsController } from "./commissions.controller";
import { PayCommissionDto } from "./dto/commission.dto";
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

describe("the old writing endpoints", () => {
  it("are gone: GET /commissions/pending/:id and POST /commissions/calculate/:id rewrote commissions", () => {
    const proto = CommissionsController.prototype as unknown as Record<string, unknown>;
    expect(proto.calculateCommission).toBeUndefined();
    expect(proto.getPendingCommissions).toBeUndefined();
  });
});
