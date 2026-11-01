import { PosController } from "./pos.controller";
import { PosService } from "./pos.service";
import {
  CreatePosOrderDto,
  CreateProductCategoryDto,
  CreateProductDto,
  InventoryAdjustmentBodyDto,
  PosQuickSaleDto,
  UpdateProductDto,
} from "./dto/pos.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

describe("POS bodies", () => {
  it("are validated classes, not interfaces or any", () => {
    expect(bodyMetatype(PosController, "checkout")).toBe(CreatePosOrderDto);
    expect(bodyMetatype(PosController, "quickSale")).toBe(PosQuickSaleDto);
    expect(bodyMetatype(PosController, "createProduct")).toBe(CreateProductDto);
    expect(bodyMetatype(PosController, "updateProduct")).toBe(UpdateProductDto);
    expect(bodyMetatype(PosController, "createProductCategory")).toBe(CreateProductCategoryDto);
    expect(bodyMetatype(PosController, "adjustInventory")).toBe(InventoryAdjustmentBodyDto);
  });

  describe("POST /pos/checkout", () => {
    const parse = bodyParser(PosController, "checkout");

    /** What app/dashboard/pos/page.tsx sends when charging an appointment. */
    const panelTicket = {
      clientId: uuid(1),
      appointmentIds: [uuid(2)],
      items: [
        { serviceId: uuid(3), appointmentId: uuid(2), name: "Corte (Ana López)", price: 4000, quantity: 1 },
        { serviceId: uuid(4), name: "Tinte", price: 2500, quantity: 2 },
      ],
      loyaltyRewardId: uuid(5),
      payments: [{ method: "card", amount: 9000 }],
    };

    it("keeps what the panel sends, without the prices", async () => {
      const out = await parse(panelTicket);
      expect(out.items).toEqual([
        { serviceId: uuid(3), appointmentId: uuid(2), quantity: 1 },
        { serviceId: uuid(4), quantity: 2 },
      ]);
      expect(out).toMatchObject({
        clientId: uuid(1),
        appointmentIds: [uuid(2)],
        loyaltyRewardId: uuid(5),
        payments: [{ method: "card", amount: 9000 }],
      });
    });

    it("drops the tenant and the actor a body may try to set", async () => {
      const out = await parse({ ...panelTicket, tenantId: uuid(6), actor: { id: "x", role: "owner" } });
      expect(out.tenantId).toBeUndefined();
      expect(out.actor).toBeUndefined();
    });

    it("refuses bad lines and tenders", async () => {
      const line = { serviceId: uuid(3), quantity: 1 };
      const pay = [{ method: "cash", amount: 100 }];
      await expect(parse({ items: [], payments: pay })).rejects.toBeDefined();
      await expect(parse({ items: [{ quantity: 1 }], payments: pay })).rejects.toBeDefined();
      await expect(parse({ items: [{ ...line, quantity: 0 }], payments: pay })).rejects.toBeDefined();
      await expect(parse({ items: [{ ...line, quantity: 1.5 }], payments: pay })).rejects.toBeDefined();
      await expect(parse({ items: [{ serviceId: "svc", quantity: 1 }], payments: pay })).rejects.toBeDefined();
      await expect(parse({ items: [line], payments: [{ method: "free", amount: 1 }] })).rejects.toBeDefined();
      await expect(parse({ items: [line], payments: [{ method: "cash", amount: -100 }] })).rejects.toBeDefined();
      await expect(parse({ items: [line], payments: [{ method: "cash", amount: 10.5 }] })).rejects.toBeDefined();
      await expect(parse({ items: [line], payments: pay, appointmentIds: [{ not: "" }] })).rejects.toBeDefined();
      await expect(parse({ items: [line], payments: pay, notes: "x".repeat(5001) })).rejects.toBeDefined();
    });
  });

  it("POST /pos/quick-sale takes a service, cash or card, and a client", async () => {
    const parse = bodyParser(PosController, "quickSale");
    const body = { serviceId: uuid(1), paymentMethod: "card", clientId: uuid(2) };
    expect(await parse({ ...body, amount: 1 })).toEqual(body);
    await expect(parse({ ...body, paymentMethod: "wallet" })).rejects.toBeDefined();
  });

  describe("products", () => {
    /** What app/dashboard/pos/products/page.tsx sends. */
    const productForm = {
      name: "Champú reparador",
      description: "500 ml",
      sku: "CH-500",
      price: 12.5,
      costPrice: 6,
      quantity: 10,
      lowStockAlert: 5,
      category: "Cuidado",
      trackInventory: true,
      isActive: true,
    };

    it("keeps the product form and drops the tenant and relations", async () => {
      const parse = bodyParser(PosController, "createProduct");
      expect(await parse(productForm)).toEqual(productForm);
      const out = await parse({ ...productForm, tenantId: uuid(1), tenant: { connect: { id: uuid(1) } } });
      expect(out.tenantId).toBeUndefined();
      expect(out.tenant).toBeUndefined();
    });

    it("reads Decimals sent back as strings on an edit", async () => {
      const parse = bodyParser(PosController, "updateProduct");
      expect(await parse({ price: "12.50", costPrice: "6.00", taxRate: "0.21" })).toEqual({
        price: 12.5,
        costPrice: 6,
        taxRate: 0.21,
      });
    });

    it("refuses negative prices and stock, and over-long names", async () => {
      const parse = bodyParser(PosController, "createProduct");
      await expect(parse({ ...productForm, price: -1 })).rejects.toBeDefined();
      await expect(parse({ ...productForm, quantity: -3 })).rejects.toBeDefined();
      await expect(parse({ ...productForm, taxRate: 21 })).rejects.toBeDefined();
      await expect(parse({ ...productForm, name: "x".repeat(201) })).rejects.toBeDefined();
    });

    it("inventory adjustments take a known type and a whole quantity", async () => {
      const parse = bodyParser(PosController, "adjustInventory");
      const body = { productId: uuid(1), type: "restock", quantity: 5, reason: "Pedido" };
      expect(await parse({ ...body, tenantId: uuid(2) })).toEqual(body);
      await expect(parse({ ...body, type: "sale" })).rejects.toBeDefined();
      await expect(parse({ ...body, quantity: -5 })).rejects.toBeDefined();
    });
  });
});

describe("POS pricing", () => {
  function pos() {
    const prisma: any = {
      payment: { create: jest.fn(async ({ data }: any) => ({ id: "p1", ...data })) },
      service: {
        findMany: jest.fn(async ({ where }: any) =>
          [{ id: "svc1", name: "Corte", price: "40.00" }].filter((s) => where.id.in.includes(s.id)),
        ),
      },
      product: {
        findMany: jest.fn(async ({ where }: any) =>
          [
            { id: "prod1", name: "Champú", price: "12.50", isActive: true },
            { id: "prod2", name: "Laca", price: "9.00", isActive: false },
          ].filter((p) => where.id.in.includes(p.id)),
        ),
      },
      client: { findFirst: jest.fn(async ({ where }: any) => (where.id === "c1" ? { id: "c1" } : null)), create: jest.fn() },
    };
    const wallet: any = { deductFunds: jest.fn(), addFunds: jest.fn() };
    return { service: new PosService(prisma, wallet), prisma, wallet };
  }

  it("prices services and products from the database, whatever the line says", async () => {
    const { service, prisma } = pos();
    const out: any = await service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      items: [
        { serviceId: "svc1", quantity: 2, price: 1 },
        { productId: "prod1", quantity: 1, price: 1 },
      ],
      payments: [{ method: "cash", amount: 9250 }],
    } as any);
    expect(out.subtotal).toBe(2 * 4000 + 1250);
    // Lines also carry their discount amounts now (all 0 here).
    expect(out.items).toMatchObject([
      { serviceId: "svc1", name: "Corte", price: 4000, quantity: 2 },
      { productId: "prod1", name: "Champú", price: 1250, quantity: 1 },
    ]);
    expect(prisma.service.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["svc1"] }, tenantId: "t1" } }));
  });

  it("refuses a ticket paid at the client's price", async () => {
    const { service, prisma } = pos();
    await expect(
      service.processCheckout({
        tenantId: "t1",
        clientId: "c1",
        items: [{ serviceId: "svc1", quantity: 1, price: 1 }],
        payments: [{ method: "cash", amount: 1 }],
      } as any),
    ).rejects.toThrow(/menor que el total/);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("refuses services and products of another salon, and products withdrawn from sale", async () => {
    const { service } = pos();
    const sell = (items: any[]) =>
      service.processCheckout({ tenantId: "t1", items, payments: [{ method: "cash", amount: 99999 }] } as any);
    await expect(sell([{ serviceId: "svc-other", quantity: 1 }])).rejects.toThrow(/Service not found/);
    await expect(sell([{ productId: "prod-other", quantity: 1 }])).rejects.toThrow(/Product not found/);
    await expect(sell([{ productId: "prod2", quantity: 1 }])).rejects.toThrow(/not available/);
    await expect(sell([{ serviceId: "svc1", productId: "prod1", quantity: 1 }])).rejects.toThrow(/one service or one product/);
  });

  it("refuses a client of another salon, and a wallet payment with no client", async () => {
    const { service, wallet } = pos();
    const items = [{ serviceId: "svc1", quantity: 1 }];
    await expect(
      service.processCheckout({ tenantId: "t1", clientId: "c-other", items, payments: [{ method: "cash", amount: 4000 }] } as any),
    ).rejects.toThrow(/Client not found/);
    await expect(
      service.processCheckout({ tenantId: "t1", items, payments: [{ method: "wallet", amount: 4000 }] } as any),
    ).rejects.toThrow(/needs a client/);
    expect(wallet.deductFunds).not.toHaveBeenCalled();
  });
});
