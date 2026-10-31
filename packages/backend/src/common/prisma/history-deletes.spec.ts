import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AdminClientsService } from "../../admin/clients/clients.service";
import { AdminProfessionalsService } from "../../admin/professionals/professionals.service";
import { ClientsService } from "../../clients/clients.service";
import { ProfessionalsService } from "../../professionals/professionals.service";
import { ServicesService } from "../../services/services.service";
import {
  CLIENT_HAS_HISTORY,
  PROFESSIONAL_HAS_HISTORY,
  SERVICE_HAS_HISTORY,
  deleteClientKeepingHistory,
  deleteProfessionalKeepingHistory,
  deleteServiceKeepingHistory,
} from "./history-deletes";

/**
 * Deleting a client, professional or service cascaded to all their
 * appointments, and the payments of those appointments were left pointing
 * nowhere. The database now refuses (Restrict); the panel deactivates a
 * record that has history and deletes only one that has none.
 */

const fkError = () =>
  new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
    code: "P2003",
    clientVersion: "5.22.0",
  });

function prismaMock(counts: { appointments?: number; payments?: number; orders?: number; blocks?: number } = {}) {
  const calls = { updates: [] as any[], deletes: [] as any[] };
  const record = (model: string) => ({
    findFirst: jest.fn(async ({ where }: any) => (where.id === "missing" ? null : { id: where.id })),
    update: jest.fn(async (args: any) => { calls.updates.push({ model, ...args }); return {}; }),
    delete: jest.fn(async (args: any) => { calls.deletes.push({ model, ...args }); return {}; }),
  });
  const prisma: any = {
    client: record("client"),
    professional: record("professional"),
    service: record("service"),
    appointment: { count: jest.fn(async () => counts.appointments ?? 0) },
    payment: { count: jest.fn(async () => counts.payments ?? 0) },
    order: { count: jest.fn(async () => counts.orders ?? 0) },
    appointmentService: { count: jest.fn(async () => counts.blocks ?? 0) },
  };
  return { prisma, calls };
}

describe("deleting a client", () => {
  it("deletes one with no history", async () => {
    const { prisma, calls } = prismaMock();
    await expect(deleteClientKeepingHistory(prisma, "t1", "c1")).resolves.toEqual({ ok: true, deactivated: false });
    expect(calls.deletes).toEqual([{ model: "client", where: { id: "c1", tenantId: "t1" } }]);
    expect(calls.updates).toHaveLength(0);
  });

  it.each([
    ["appointments", { appointments: 2 }],
    ["payments", { payments: 1 }],
    ["orders", { orders: 1 }],
  ])("deactivates one with %s instead of deleting it", async (_label, counts) => {
    const { prisma, calls } = prismaMock(counts);
    await expect(deleteClientKeepingHistory(prisma, "t1", "c1")).resolves.toEqual({ ok: true, deactivated: true });
    expect(calls.deletes).toHaveLength(0);
    expect(calls.updates).toEqual([
      { model: "client", where: { id: "c1", tenantId: "t1" }, data: { status: "inactive" } },
    ]);
  });

  it("counts only this salon's history", async () => {
    const { prisma } = prismaMock();
    await deleteClientKeepingHistory(prisma, "t1", "c1");
    expect(prisma.appointment.count).toHaveBeenCalledWith({ where: { tenantId: "t1", clientId: "c1" } });
    expect(prisma.payment.count).toHaveBeenCalledWith({ where: { tenantId: "t1", clientId: "c1" } });
  });

  it("is a 404 for a client that is not this salon's", async () => {
    const { prisma, calls } = prismaMock();
    await expect(deleteClientKeepingHistory(prisma, "t1", "missing")).rejects.toThrow(NotFoundException);
    expect(calls.deletes).toHaveLength(0);
  });

  it("turns the database refusing into a 409 that says why, not a 500", async () => {
    const { prisma } = prismaMock();
    prisma.client.delete.mockRejectedValueOnce(fkError());
    const err = await deleteClientKeepingHistory(prisma, "t1", "c1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(CLIENT_HAS_HISTORY);
  });

  it("does not hide other database errors", async () => {
    const { prisma } = prismaMock();
    const boom = new Error("connection lost");
    prisma.client.delete.mockRejectedValueOnce(boom);
    await expect(deleteClientKeepingHistory(prisma, "t1", "c1")).rejects.toBe(boom);
  });

  it("is what both client endpoints do", async () => {
    for (const make of [(p: any) => new ClientsService(p), (p: any) => new AdminClientsService(p)]) {
      const { prisma, calls } = prismaMock({ appointments: 1 });
      await expect(make(prisma).remove("t1", "c1")).resolves.toEqual({ ok: true, deactivated: true });
      expect(calls.deletes).toHaveLength(0);
    }
  });
});

describe("deleting a professional", () => {
  it("deletes one with no history", async () => {
    const { prisma, calls } = prismaMock();
    await expect(deleteProfessionalKeepingHistory(prisma, "t1", "p1")).resolves.toEqual({ ok: true, deactivated: false });
    expect(calls.deletes).toEqual([{ model: "professional", where: { id: "p1", tenantId: "t1" } }]);
  });

  it.each([
    ["appointments", { appointments: 3 }],
    ["work blocks in other appointments", { blocks: 1 }],
  ])("deactivates one with %s", async (_label, counts) => {
    const { prisma, calls } = prismaMock(counts);
    await expect(deleteProfessionalKeepingHistory(prisma, "t1", "p1")).resolves.toEqual({ ok: true, deactivated: true });
    expect(calls.deletes).toHaveLength(0);
    expect(calls.updates).toEqual([
      { model: "professional", where: { id: "p1", tenantId: "t1" }, data: { isActive: false } },
    ]);
  });

  it("is a 409 when the database refuses", async () => {
    const { prisma } = prismaMock();
    prisma.professional.delete.mockRejectedValueOnce(fkError());
    await expect(deleteProfessionalKeepingHistory(prisma, "t1", "p1")).rejects.toThrow(PROFESSIONAL_HAS_HISTORY);
  });

  it("is a 404 for someone not in this salon", async () => {
    const { prisma } = prismaMock();
    await expect(deleteProfessionalKeepingHistory(prisma, "t1", "missing")).rejects.toThrow(NotFoundException);
  });

  it("is what both professional endpoints do, scoped to the caller's salon", async () => {
    const makers = [
      (p: any) => new ProfessionalsService(p),
      (p: any) => new AdminProfessionalsService(p),
    ];
    for (const make of makers) {
      const { prisma, calls } = prismaMock({ appointments: 1 });
      await expect(make(prisma).remove("t1", "p1")).resolves.toEqual({ ok: true, deactivated: true });
      expect(prisma.professional.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1", tenantId: "t1" } }));
      expect(calls.deletes).toHaveLength(0);
    }
  });
});

describe("deleting a service", () => {
  it("deletes one with no history", async () => {
    const { prisma, calls } = prismaMock();
    await expect(new ServicesService(prisma).remove("t1", "s1")).resolves.toEqual({ ok: true, deactivated: false });
    expect(calls.deletes).toEqual([{ model: "service", where: { id: "s1", tenantId: "t1" } }]);
  });

  it.each([
    ["appointments", { appointments: 1 }],
    ["a place in a multi-service appointment", { blocks: 2 }],
  ])("deactivates one with %s", async (_label, counts) => {
    const { prisma, calls } = prismaMock(counts);
    await expect(deleteServiceKeepingHistory(prisma, "t1", "s1")).resolves.toEqual({ ok: true, deactivated: true });
    expect(calls.updates).toEqual([
      { model: "service", where: { id: "s1", tenantId: "t1" }, data: { isActive: false } },
    ]);
    expect(calls.deletes).toHaveLength(0);
  });

  it("is a 409 when the database refuses", async () => {
    const { prisma } = prismaMock();
    prisma.service.delete.mockRejectedValueOnce(fkError());
    await expect(deleteServiceKeepingHistory(prisma, "t1", "s1")).rejects.toThrow(SERVICE_HAS_HISTORY);
  });

  it("is a 404 for a service that is not this salon's", async () => {
    const { prisma } = prismaMock();
    await expect(deleteServiceKeepingHistory(prisma, "t1", "missing")).rejects.toThrow(NotFoundException);
  });
});
