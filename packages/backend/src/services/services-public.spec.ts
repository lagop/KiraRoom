import { NotFoundException } from "@nestjs/common";
import { ServicesController } from "./services.controller";
import { ServicesService } from "./services.service";

/**
 * Who sees which services.
 *
 * `GET /services/:id` is @Public() and looked the id up in every salon: any
 * service, in full (deposit settings, internal lists), to anyone holding its
 * id. `GET /services?tenantId=` gave an anonymous caller the whole
 * catalogue, deactivated and offline-only services included. And
 * `PUT /services/:id` found the row by id alone.
 */

const ROWS = [
  { id: "s-on", tenantId: "salon-a", name: "Corte", price: "30.00", isActive: true, isOnlineBookable: true, depositAmount: 500, staff: ["x"] },
  { id: "s-off", tenantId: "salon-a", name: "Tinte", price: "45.00", isActive: false, isOnlineBookable: true, depositAmount: null, staff: [] },
  { id: "s-desk", tenantId: "salon-a", name: "Novia", isActive: true, isOnlineBookable: false, depositAmount: null, staff: [] },
  { id: "s-b", tenantId: "salon-b", name: "Manicura", isActive: true, isOnlineBookable: true, depositAmount: null, staff: [] },
];

const matches = (row: any, where: any) =>
  Object.entries(where).every(([k, v]) => row[k] === v);

const project = (row: any, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;

function build(
  viewer: { tenantId: string; staff: boolean },
  // salon-a writes its catalogue without the IVA (a salon from before the setting).
  fiscalSettings: Record<string, unknown> = { pricesIncludeTax: false, defaultTaxRate: 21 },
) {
  const updates: any[] = [];
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({ fiscalSettings })),
    },
    service: {
      findMany: jest.fn(async ({ where, select }: any) =>
        ROWS.filter((r) => matches(r, where)).map((r) => project(r, select)),
      ),
      findFirst: jest.fn(async ({ where, select }: any) => {
        const row = ROWS.find((r) => matches(r, where));
        return row ? project(row, select) : null;
      }),
      update: jest.fn(async (args: any) => (updates.push(args), { id: args.where.id })),
    },
  };
  const publicViewer: any = { resolve: jest.fn(async () => viewer) };
  const controller = new ServicesController(new ServicesService(prisma), {} as any, publicViewer);
  return { controller, prisma, updates, publicViewer };
}

describe("GET /services", () => {
  it("gives the salon's staff every service, ordered by category and name", async () => {
    const { controller, prisma } = build({ tenantId: "salon-a", staff: true });
    const rows = await controller.findAll({}, undefined);
    expect(rows.map((r: any) => r.id).sort()).toEqual(["s-desk", "s-off", "s-on"]);
    expect(prisma.service.findMany.mock.calls[0][0].orderBy).toEqual([{ category: "asc" }, { name: "asc" }]);
  });

  it("gives anyone else only what can be booked online, without internal settings", async () => {
    const { controller } = build({ tenantId: "salon-a", staff: false });
    const rows = await controller.findAll({}, "salon-a");
    expect(rows.map((r: any) => r.id)).toEqual(["s-on"]);
    expect(rows[0]).not.toHaveProperty("depositAmount");
    expect(rows[0]).not.toHaveProperty("staff");
    expect(rows[0]).toHaveProperty("name", "Corte");
  });

  it("gives clients the final price, tax included; the salon's staff the catalogue price", async () => {
    const visitor = build({ tenantId: "salon-a", staff: false });
    const rows = await visitor.controller.findAll({}, "salon-a");
    expect(rows[0]).toMatchObject({ id: "s-on", price: 36.3, taxLabel: "IVA" });
    expect(visitor.prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: "salon-a" },
      select: { fiscalSettings: true },
    });

    const staff = build({ tenantId: "salon-a", staff: true });
    const own = await staff.controller.findAll({}, undefined);
    expect(own.find((r: any) => r.id === "s-on")).toMatchObject({ price: "30.00" });
    expect(staff.prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("leaves a catalogue that already includes the tax as it is, and names IGIC in the Canaries", async () => {
    const included = build({ tenantId: "salon-a", staff: false }, { pricesIncludeTax: true, defaultTaxRate: 21 });
    expect((await included.controller.findAll({}, "salon-a"))[0]).toMatchObject({ price: 30, taxLabel: "IVA" });

    const canary = build(
      { tenantId: "salon-a", staff: false },
      { pricesIncludeTax: false, defaultTaxRate: 7, taxRegime: "igic" },
    );
    expect((await canary.controller.findAll({}, "salon-a"))[0]).toMatchObject({ price: 32.1, taxLabel: "IGIC" });
  });
});

describe("GET /services/:id", () => {
  it("resolves the salon like the list does", async () => {
    const { controller, publicViewer } = build({ tenantId: "salon-a", staff: false });
    const req = { headers: {} };
    await controller.findOne(req, "s-on", "salon-a");
    expect(publicViewer.resolve).toHaveBeenCalledWith(req, "salon-a");
  });

  it("does not answer another salon's service", async () => {
    const staff = build({ tenantId: "salon-a", staff: true });
    await expect(staff.controller.findOne({}, "s-b")).rejects.toThrow(NotFoundException);
    const visitor = build({ tenantId: "salon-a", staff: false });
    await expect(visitor.controller.findOne({}, "s-b", "salon-a")).rejects.toThrow(NotFoundException);
  });

  it("hides deactivated and offline-only services from outside the salon", async () => {
    const { controller } = build({ tenantId: "salon-a", staff: false });
    await expect(controller.findOne({}, "s-off", "salon-a")).rejects.toThrow(NotFoundException);
    await expect(controller.findOne({}, "s-desk", "salon-a")).rejects.toThrow(NotFoundException);
    const row = await controller.findOne({}, "s-on", "salon-a");
    expect(row).not.toHaveProperty("depositAmount");
    expect(row).toMatchObject({ price: 36.3, taxLabel: "IVA" });
  });

  it("shows the salon's staff any of its services in full", async () => {
    const { controller } = build({ tenantId: "salon-a", staff: true });
    const row = await controller.findOne({}, "s-off");
    expect(row).toMatchObject({ id: "s-off", isActive: false, depositAmount: null });
  });
});

describe("PUT /services/:id", () => {
  it("edits only a service of the caller's salon", async () => {
    const { controller, updates } = build({ tenantId: "salon-a", staff: true });
    await expect(
      controller.update({ tenantId: "salon-a" }, "s-b", { name: "Robada" } as any),
    ).rejects.toThrow(NotFoundException);
    expect(updates).toHaveLength(0);

    await controller.update({ tenantId: "salon-a" }, "s-on", { name: "Corte largo" } as any);
    expect(updates[0].where).toEqual({ id: "s-on", tenantId: "salon-a" });
  });
});
