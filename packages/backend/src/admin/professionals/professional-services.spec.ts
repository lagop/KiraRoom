import { BadRequestException } from "@nestjs/common";
import { AdminProfessionalsService } from "./professionals.service";

/**
 * Which services a professional performs (ProfessionalService).
 *
 * Any existing service id was accepted, another salon's included; an empty
 * list was ignored, so the last service could never be unticked; and the
 * delete and the re-create ran apart, so a failure in between left the
 * professional with no services.
 */

const OWN = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const FOREIGN = "33333333-3333-4333-8333-333333333333";

function db() {
  const ops: string[] = [];
  const tx: any = {
    professional: { update: jest.fn(async (args: any) => (ops.push("update"), { id: args.where.id })) },
    professionalService: {
      deleteMany: jest.fn(async () => (ops.push("deleteMany"), { count: 1 })),
      createMany: jest.fn(async (args: any) => (ops.push(`createMany:${args.data.length}`), { count: args.data.length })),
    },
  };
  const prisma: any = {
    ...tx,
    service: {
      count: jest.fn(async ({ where }: any) =>
        where.tenantId === "salon-a" ? where.id.in.filter((id: string) => OWN.includes(id)).length : 0,
      ),
    },
    $transaction: jest.fn(async (fn: any) => {
      ops.push("begin");
      const out = await fn(tx);
      ops.push("commit");
      return out;
    }),
  };
  return { prisma, tx, ops, service: new AdminProfessionalsService(prisma) };
}

describe("updating a professional's services", () => {
  it("replaces them in one transaction", async () => {
    const { service, ops, tx } = db();
    await service.update("salon-a", "pro-1", { serviceIds: OWN } as any);
    expect(ops).toEqual(["begin", "update", "deleteMany", "createMany:2", "commit"]);
    expect(tx.professionalService.createMany.mock.calls[0][0].data).toEqual(
      OWN.map((serviceId) => ({ professionalId: "pro-1", serviceId })),
    );
  });

  it("clears them all with an empty list", async () => {
    const { service, ops } = db();
    await service.update("salon-a", "pro-1", { serviceIds: [] } as any);
    expect(ops).toEqual(["begin", "update", "deleteMany", "commit"]);
  });

  it("leaves them alone when the list is not sent", async () => {
    const { service, ops } = db();
    await service.update("salon-a", "pro-1", { firstName: "Ana" } as any);
    expect(ops).toEqual(["update"]);
  });

  it("refuses another salon's service before writing anything", async () => {
    const { service, ops } = db();
    await expect(
      service.update("salon-a", "pro-1", { serviceIds: [OWN[0], FOREIGN] } as any),
    ).rejects.toThrow(BadRequestException);
    expect(ops).toEqual([]);
  });

  it("counts a repeated id once", async () => {
    const { service, tx } = db();
    await service.update("salon-a", "pro-1", { serviceIds: [OWN[0], OWN[0]] } as any);
    expect(tx.professionalService.createMany.mock.calls[0][0].data).toHaveLength(1);
  });
});

describe("creating a professional with services", () => {
  it("refuses another salon's service", async () => {
    const { prisma, service } = db();
    // No tenant row: the plan's professional limit is not what this checks.
    prisma.tenant = { findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => ({ id: "salon-a" })) };
    prisma.professional.create = jest.fn();
    await expect(
      service.create({ tenantId: "salon-a", firstName: "Ana", lastName: "L", email: "a@x.test", serviceIds: [FOREIGN] } as any),
    ).rejects.toThrow(/no existe en este salón/);
    expect(prisma.professional.create).not.toHaveBeenCalled();
  });
});
