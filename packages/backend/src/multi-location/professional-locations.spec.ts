import "reflect-metadata";
import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from "@nestjs/common";
import { assertProfessionalsAt, professionalsAt, setProfessionalLocations } from "./professional-locations";
import { AdminProfessionalsService } from "../admin/professionals/professionals.service";
import { UpdateProfessionalDto } from "../admin/professionals/dto";

/**
 * A professional at several of the salon's locations.
 *
 * The join table existed (with isPrimary) and the consolidated report read
 * it, but nothing wrote it: the team form had no field. Now the form sends
 * the list, gated by the plan's multi-location feature.
 */

const LOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOC_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** Another salon's location. */
const FOREIGN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Link = { professionalId: string; locationId: string; isPrimary: boolean };

/** A fake database with the salon's open locations A, B and C. */
function fakeDb(links: Link[] = []) {
  const locations = [
    { id: LOC_A, tenantId: "salon-a", isActive: true },
    { id: LOC_B, tenantId: "salon-a", isActive: true },
    { id: LOC_C, tenantId: "salon-a", isActive: false },
    { id: FOREIGN, tenantId: "salon-b", isActive: true },
  ];
  const match = (l: any, where: any) =>
    l.tenantId === where.tenantId && (where.isActive === undefined || l.isActive === where.isActive);
  const db: any = {
    links,
    location: {
      findMany: jest.fn(async ({ where }: any) => locations.filter((l) => match(l, where) && where.id.in.includes(l.id))),
      findFirst: jest.fn(async ({ where }: any) => locations.find((l) => match(l, where) && l.id === where.id) ?? null),
      count: jest.fn(async ({ where }: any) => locations.filter((l) => match(l, where) && where.id.in.includes(l.id)).length),
    },
    professionalLocation: {
      findMany: jest.fn(async ({ where }: any) =>
        db.links.filter(
          (l: Link) =>
            (where.professionalId === undefined || l.professionalId === where.professionalId) &&
            (where.locationId === undefined || l.locationId === where.locationId),
        ),
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        db.links = db.links.filter(
          (l: Link) => !(l.professionalId === where.professionalId && !where.locationId.notIn.includes(l.locationId)),
        );
      }),
      createMany: jest.fn(async ({ data }: any) => {
        db.links.push(...data);
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        for (const l of db.links as Link[]) {
          if (l.professionalId !== where.professionalId) continue;
          if (typeof where.locationId === "string" && l.locationId !== where.locationId) continue;
          if (where.locationId?.not && l.locationId === where.locationId.not) continue;
          if (where.isPrimary !== undefined && l.isPrimary !== where.isPrimary) continue;
          Object.assign(l, data);
        }
      }),
    },
  };
  return db;
}

const sorted = (links: Link[]) =>
  links.map((l) => `${l.locationId === LOC_A ? "A" : l.locationId === LOC_B ? "B" : "?"}${l.isPrimary ? "*" : ""}`).sort();

describe("setProfessionalLocations", () => {
  it("assigns several locations, the first one primary", async () => {
    const db = fakeDb();
    await setProfessionalLocations(db, "salon-a", "ana", [LOC_A, LOC_B]);
    expect(sorted(db.links)).toEqual(["A*", "B"]);
  });

  it("moves the primary one when asked, and keeps it when it stays", async () => {
    const db = fakeDb([
      { professionalId: "ana", locationId: LOC_A, isPrimary: false },
      { professionalId: "ana", locationId: LOC_B, isPrimary: true },
    ]);
    await setProfessionalLocations(db, "salon-a", "ana", [LOC_A, LOC_B]);
    expect(sorted(db.links)).toEqual(["A", "B*"]);
    await setProfessionalLocations(db, "salon-a", "ana", [LOC_A, LOC_B], LOC_A);
    expect(sorted(db.links)).toEqual(["A*", "B"]);
  });

  it("removes the links left out, and all of them with an empty list", async () => {
    const db = fakeDb([
      { professionalId: "ana", locationId: LOC_A, isPrimary: true },
      { professionalId: "ana", locationId: LOC_B, isPrimary: false },
      { professionalId: "bea", locationId: LOC_A, isPrimary: true },
    ]);
    await setProfessionalLocations(db, "salon-a", "ana", [LOC_B]);
    expect(sorted(db.links.filter((l: Link) => l.professionalId === "ana"))).toEqual(["B*"]);
    await setProfessionalLocations(db, "salon-a", "ana", []);
    expect(db.links).toEqual([{ professionalId: "bea", locationId: LOC_A, isPrimary: true }]);
  });

  it("refuses another salon's location, a closed one, and a primary outside the list", async () => {
    await expect(setProfessionalLocations(fakeDb(), "salon-a", "ana", [LOC_A, FOREIGN])).rejects.toThrow(BadRequestException);
    await expect(setProfessionalLocations(fakeDb(), "salon-a", "ana", [LOC_C])).rejects.toThrow(BadRequestException);
    await expect(setProfessionalLocations(fakeDb(), "salon-a", "ana", [LOC_A], LOC_B)).rejects.toThrow(BadRequestException);
  });
});

describe("who works at a location", () => {
  const links: Link[] = [
    { professionalId: "ana", locationId: LOC_A, isPrimary: true },
    { professionalId: "ana", locationId: LOC_B, isPrimary: false },
    { professionalId: "bea", locationId: LOC_B, isPrimary: true },
  ];

  it("everyone assigned to it, whatever their primary location", async () => {
    expect([...(await professionalsAt(fakeDb(links), "salon-a", LOC_B))].sort()).toEqual(["ana", "bea"]);
    expect([...(await professionalsAt(fakeDb(links), "salon-a", LOC_A))]).toEqual(["ana"]);
  });

  it("404 for another salon's location or a closed one", async () => {
    await expect(professionalsAt(fakeDb(links), "salon-a", FOREIGN)).rejects.toThrow(NotFoundException);
    await expect(professionalsAt(fakeDb(links), "salon-a", LOC_C)).rejects.toThrow(NotFoundException);
  });

  it("a booking there may only name them", async () => {
    await expect(assertProfessionalsAt(fakeDb(links), "salon-a", LOC_B, ["ana", "bea", null])).resolves.toBeUndefined();
    await expect(assertProfessionalsAt(fakeDb(links), "salon-a", LOC_A, ["ana", "bea"])).rejects.toThrow(BadRequestException);
  });
});

describe("the team form's locations", () => {
  function team(enabled: boolean, links: Link[] = []) {
    const db = fakeDb(links);
    const prisma: any = {
      ...db,
      professional: {
        findFirst: jest.fn(async () => ({ isActive: true, email: "ana@salon.test", user: null })),
        update: jest.fn(async (args: any) => ({ id: args.where.id })),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    Object.defineProperty(prisma, "links", { get: () => db.links });
    const flags: any = { isEnabled: jest.fn(async (_t: string, key: string) => enabled && key === "multi_location") };
    return { prisma, db, service: new AdminProfessionalsService(prisma, flags), flags };
  }

  it("saves the locations ticked, and the main one", async () => {
    const { service, db } = team(true);
    await service.update("salon-a", "ana", { locationIds: [LOC_A, LOC_B], primaryLocationId: LOC_B } as any);
    expect(sorted(db.links)).toEqual(["A", "B*"]);
  });

  it("is part of the plan with multi-location: without it, assigning is refused before anything is written", async () => {
    const { service, prisma, db } = team(false);
    await expect(service.update("salon-a", "ana", { locationIds: [LOC_A] } as any)).rejects.toThrow(ForbiddenException);
    expect(prisma.professional.update).not.toHaveBeenCalled();
    expect(db.links).toEqual([]);
  });

  it("clearing them is always allowed (a salon that left the plan)", async () => {
    const { service, db } = team(false, [{ professionalId: "ana", locationId: LOC_A, isPrimary: true }]);
    await service.update("salon-a", "ana", { locationIds: [] } as any);
    expect(db.links).toEqual([]);
  });

  it("left out, they are not touched", async () => {
    const { service, db, flags } = team(true, [{ professionalId: "ana", locationId: LOC_A, isPrimary: true }]);
    await service.update("salon-a", "ana", { firstName: "Ana" } as any);
    expect(db.links).toHaveLength(1);
    expect(flags.isEnabled).not.toHaveBeenCalled();
  });

  it("refuses another salon's location before anything is written", async () => {
    const { service, prisma } = team(true);
    await expect(service.update("salon-a", "ana", { locationIds: [FOREIGN] } as any)).rejects.toThrow(BadRequestException);
    expect(prisma.professional.update).not.toHaveBeenCalled();
  });

  it("the body takes a list of location ids and a main one", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const meta = { type: "body", metatype: UpdateProfessionalDto } as any;
    const ok = await pipe.transform({ locationIds: [LOC_A, LOC_B], primaryLocationId: LOC_A }, meta);
    expect(ok).toMatchObject({ locationIds: [LOC_A, LOC_B], primaryLocationId: LOC_A });
    await expect(pipe.transform({ locationIds: ["nope"] }, meta)).rejects.toBeDefined();
  });
});
