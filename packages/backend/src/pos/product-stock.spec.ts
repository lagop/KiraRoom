import { ConflictException } from "@nestjs/common";
import { ProductService } from "./product.service";
import { CommissionsService } from "../commissions/commissions.service";

/**
 * Products and their stock outside the till: counts logged as the
 * difference, an edited quantity going through that log, products with
 * history deactivated instead of deleted, and the till's walk-in service
 * lines in the commissions report.
 */

type Row = Record<string, any>;

function products(start: Row = {}) {
  const product: Row = { id: "prod1", tenantId: "t1", name: "Champú", quantity: 10, isActive: true, ...start };
  const log: Row[] = [];
  const prisma: any = {
    product: {
      findFirst: jest.fn(async ({ where }: any) => (where.id === product.id && where.tenantId === product.tenantId ? { ...product } : null)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.id !== product.id || where.quantity !== product.quantity) return { count: 0 };
        Object.assign(product, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => Object.assign(product, data)),
      delete: jest.fn(async () => product),
    },
    inventoryTransaction: {
      create: jest.fn(async ({ data }: any) => (log.push(data), data)),
      count: jest.fn(async () => log.length),
    },
    productOrder: { count: jest.fn(async () => 0) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { svc: new ProductService(prisma), prisma, product, log };
}

describe("inventory adjustments", () => {
  it("a count logs the difference, not minus the new stock", async () => {
    const t = products();
    await t.svc.adjustInventory({ tenantId: "t1", productId: "prod1", type: "adjustment", quantity: 12 });
    expect(t.product.quantity).toBe(12);
    expect(t.log).toEqual([expect.objectContaining({ type: "adjustment", quantity: 2, previousQty: 10, newQty: 12 })]);
    await t.svc.adjustInventory({ tenantId: "t1", productId: "prod1", type: "damaged", quantity: 3 });
    expect(t.log[1]).toMatchObject({ quantity: -3, previousQty: 12, newQty: 9 });
  });

  it("refuses to go below zero, in Spanish", async () => {
    const t = products({ quantity: 2 });
    await expect(t.svc.adjustInventory({ tenantId: "t1", productId: "prod1", type: "expired", quantity: 3 })).rejects.toThrow(
      "No hay tantas unidades de Champú: quedan 2.",
    );
  });

  it("a sale meanwhile: 409 instead of overwriting the stock", async () => {
    const t = products();
    t.prisma.product.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(t.svc.adjustInventory({ tenantId: "t1", productId: "prod1", type: "restock", quantity: 5 })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(t.log).toHaveLength(0);
  });

  it("another salon's product is a 404", async () => {
    const t = products();
    await expect(t.svc.adjustInventory({ tenantId: "t2", productId: "prod1", type: "restock", quantity: 5 })).rejects.toThrow(
      "Producto no encontrado",
    );
  });
});

describe("editing a product", () => {
  it("a new quantity goes through the inventory log", async () => {
    const t = products();
    await t.svc.updateProduct("t1", "prod1", { quantity: 7, name: "Champú 500 ml" } as any);
    expect(t.log).toEqual([expect.objectContaining({ type: "adjustment", quantity: -3, previousQty: 10, newQty: 7 })]);
    expect(t.prisma.product.update.mock.calls[0][0].data).toEqual({ name: "Champú 500 ml" });
  });
});

describe("deleting a product", () => {
  it("with history: deactivated, its log kept", async () => {
    const t = products();
    t.log.push({ type: "sale" });
    const out = await t.svc.deleteProduct("t1", "prod1");
    expect(out).toMatchObject({ isActive: false, deactivated: true });
    expect(t.prisma.product.delete).not.toHaveBeenCalled();
  });

  it("without history: deleted", async () => {
    const t = products();
    const out = await t.svc.deleteProduct("t1", "prod1");
    expect(out).toMatchObject({ deleted: true });
    expect(t.prisma.product.delete).toHaveBeenCalled();
  });
});

describe("commissions of the till's walk-in services", () => {
  it("are in the professional's summary as pending, from the sale line", async () => {
    const prisma: any = {
      professional: { findFirst: jest.fn(async () => ({ id: "p1", firstName: "Lucía", lastName: "M", commissionRate: 30 })) },
      appointment: { findMany: jest.fn(async () => []) },
      posSaleLine: {
        findMany: jest.fn(async ({ where }: any) => {
          expect(where).toMatchObject({ kind: "service", tenantId: "t1", professionalId: "p1", commissionPaid: false });
          return [
            {
              id: "l1",
              createdAt: new Date(),
              description: "Corte",
              commissionBaseCents: 4000,
              commissionRate: 30,
              commissionAmount: 1200,
              commissionPaid: false,
              professionalId: "p1",
            },
          ];
        }),
      },
    };
    const summary = await new CommissionsService(prisma).getCommissionSummary("t1", "p1");
    expect(summary.pendingCommission).toBe(1200);
    expect(summary.appointments).toEqual([
      expect.objectContaining({ id: "l1", serviceName: "Corte", clientName: "Venta en caja", amount: 4000, commissionAmount: 1200, source: "sale" }),
    ]);
  });
});
