import { PromotionsController } from "./promotions.controller";
import { CreatePromotionDto, UpdatePromotionDto } from "./dto/promotion.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

/** What the promotions page submits (app/dashboard/promotions/page.tsx). */
const panelForm = {
  name: "Otoño",
  description: "",
  code: "OTONO10",
  type: "PERCENTAGE",
  value: 10,
  minOrderValue: 0,
  maxUses: null,
  maxUsesPerClient: 1,
  startDate: "2026-11-01",
  endDate: null,
};

describe("promotion bodies", () => {
  it("are validated classes, not interfaces", () => {
    expect(bodyMetatype(PromotionsController, "create")).toBe(CreatePromotionDto);
    expect(bodyMetatype(PromotionsController, "update")).toBe(UpdatePromotionDto);
  });

  it("has no endpoint that records a use: the till is the only writer", () => {
    expect((PromotionsController.prototype as any).apply).toBeUndefined();
  });

  describe("POST /promotions", () => {
    const parse = bodyParser(PromotionsController, "create");

    it("keeps the panel form", async () => {
      expect(await parse(panelForm)).toEqual(panelForm);
    });

    it("drops columns the form does not own", async () => {
      const out = await parse({
        ...panelForm,
        tenantId: uuid(1),
        usedCount: -50,
        isActive: true,
        tenant: { connect: { id: uuid(2) } },
      });
      expect(Object.keys(out).sort()).toEqual(Object.keys(panelForm).sort());
    });

    it("refuses bad values", async () => {
      await expect(parse({ ...panelForm, type: "FREE_MONEY" })).rejects.toBeDefined();
      await expect(parse({ ...panelForm, value: -10 })).rejects.toBeDefined();
      await expect(parse({ ...panelForm, value: null })).rejects.toBeDefined();
      await expect(parse({ ...panelForm, maxUses: 0 })).rejects.toBeDefined();
      await expect(parse({ ...panelForm, maxUsesPerClient: 1.5 })).rejects.toBeDefined();
      await expect(parse({ ...panelForm, code: "TWO WORDS" })).rejects.toBeDefined();
      await expect(parse({ ...panelForm, code: "X".repeat(51) })).rejects.toBeDefined();
      await expect(parse({ ...panelForm, name: "x".repeat(201) })).rejects.toBeDefined();
      await expect(parse({ ...panelForm, startDate: "yesterday" })).rejects.toBeDefined();
    });
  });

  describe("PUT /promotions/:id", () => {
    const parse = bodyParser(PromotionsController, "update");

    it("keeps the full form (minus the code) and the active toggle", async () => {
      const { code: _code, ...rest } = panelForm;
      expect(await parse(panelForm)).toEqual(rest);
      expect(await parse({ isActive: false })).toEqual({ isActive: false });
    });

    it("reads Decimals sent back as strings", async () => {
      expect(await parse({ value: "15.50", minOrderValue: "20" })).toEqual({ value: 15.5, minOrderValue: 20 });
    });

    it("drops the usage counter and the tenant", async () => {
      expect(await parse({ usedCount: 0, tenantId: uuid(1) })).toEqual({});
    });
  });

  describe("applicable services", () => {
    const create = bodyParser(PromotionsController, "create");
    const update = bodyParser(PromotionsController, "update");

    it("take a list of service ids", async () => {
      expect(await create({ ...panelForm, applicableServiceIds: [uuid(3)] })).toEqual({
        ...panelForm,
        applicableServiceIds: [uuid(3)],
      });
      expect(await update({ applicableServiceIds: [] })).toEqual({ applicableServiceIds: [] });
    });

    it("refuse anything but ids", async () => {
      await expect(create({ ...panelForm, applicableServiceIds: ["corte"] })).rejects.toBeDefined();
      await expect(update({ applicableServiceIds: "x" })).rejects.toBeDefined();
    });
  });
});
