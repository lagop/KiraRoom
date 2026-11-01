import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AdminClientsService } from "../admin/clients/clients.service";
import {
  CreateClientDto as AdminCreateClientDto,
  UpdateClientDto as AdminUpdateClientDto,
} from "../admin/clients/dto";
import {
  CLIENT_DETAIL_SELECT,
  CLIENT_HEALTH_COLUMNS,
  CLIENT_LIST_SELECT,
  CLIENT_POS_SELECT,
  CLIENT_SECRET_COLUMNS,
} from "./client-select";
import { buildClientCreateData, buildClientUpdateData, normalizeClientTaxId } from "./client-write";
import { ClientsController } from "./clients.controller";
import { ClientsService } from "./clients.service";
import { CreateClientDto, UpdateClientDto } from "./dto";

/**
 * The clients panel and its two APIs (/clients and /admin/clients):
 * what a response may carry, what a write stores, and which clients a
 * staff member reaches.
 */

const VALID_NIF = "12345678Z";

function errorsOf(cls: any, body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(cls, body), { whitelist: true }).map((e) => e.property);
}

function p2002() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

describe("client selects", () => {
  const scalarColumns = Object.values(Prisma.ClientScalarFieldEnum) as string[];
  const secrets = CLIENT_SECRET_COLUMNS as readonly string[];
  const health = CLIENT_HEALTH_COLUMNS as readonly string[];

  it("every Client column is either selected for the panel or explicitly left out", () => {
    const decided = new Set([...Object.keys(CLIENT_LIST_SELECT), ...secrets, ...health]);
    expect(scalarColumns.filter((c) => !decided.has(c))).toEqual([]);
  });

  it("no select carries a sign-in secret", () => {
    for (const select of [CLIENT_LIST_SELECT, CLIENT_DETAIL_SELECT, CLIENT_POS_SELECT]) {
      for (const secret of secrets) expect(Object.keys(select)).not.toContain(secret);
    }
  });

  it("health data only in the single-client detail", () => {
    for (const column of health) {
      expect(Object.keys(CLIENT_LIST_SELECT)).not.toContain(column);
      expect(Object.keys(CLIENT_POS_SELECT)).not.toContain(column);
      expect(Object.keys(CLIENT_DETAIL_SELECT)).toContain(column);
    }
  });
});

describe("tax id", () => {
  it("checks and normalizes a NIF / CIF / NIE", () => {
    expect(normalizeClientTaxId(" 12345678-z ", "nif")).toBe(VALID_NIF);
    expect(() => normalizeClientTaxId("12345678A", "nif")).toThrow(BadRequestException);
    // No type: treated as a Spanish id, as before.
    expect(() => normalizeClientTaxId("999", undefined)).toThrow(BadRequestException);
  });

  it("stores a passport or other document as typed", () => {
    expect(normalizeClientTaxId(" ab123456 ", "passport")).toBe("AB123456");
    expect(normalizeClientTaxId("X-1", "other")).toBe("X-1");
  });

  it("empty means none; left out means untouched", () => {
    expect(normalizeClientTaxId("", "nif")).toBeNull();
    expect(normalizeClientTaxId(null, "nif")).toBeNull();
    expect(normalizeClientTaxId(undefined, "nif")).toBeUndefined();
  });

  it("changing only the type re-checks the id on file", () => {
    expect(() =>
      buildClientUpdateData({ taxIdType: "nif" }, { taxId: "AB123456", taxIdType: "passport" }),
    ).toThrow(BadRequestException);
    expect(
      buildClientUpdateData({ taxIdType: "passport" }, { taxId: VALID_NIF, taxIdType: "nif" }),
    ).toMatchObject({ taxIdType: "passport", taxId: VALID_NIF });
  });
});

describe("write payloads", () => {
  it("an update empties the optional fields sent as null and leaves the rest alone", () => {
    const data = buildClientUpdateData(
      { email: null, phone: "", dateOfBirth: null, gender: null, notes: null, taxId: null, taxIdType: null },
      { taxId: VALID_NIF, taxIdType: "nif" },
    );
    expect(data).toEqual({
      email: null,
      phone: null,
      dateOfBirth: null,
      gender: null,
      notes: null,
      taxId: null,
      taxIdType: null,
    });
  });

  it("an update stores a date of birth as a date", () => {
    const data = buildClientUpdateData({ dateOfBirth: "1990-05-17" }, { taxId: null, taxIdType: null });
    expect(data.dateOfBirth).toEqual(new Date("1990-05-17"));
  });

  it("a create keeps notes and status, and defaults the status to active", () => {
    expect(
      buildClientCreateData("t1", { firstName: "Ana", lastName: "Ruiz", notes: "Tinte 6.1", status: "inactive" }),
    ).toMatchObject({ tenantId: "t1", notes: "Tinte 6.1", status: "inactive" });
    expect(buildClientCreateData("t1", { firstName: "Ana", lastName: "Ruiz" }).status).toBe("active");
  });
});

describe("DTOs", () => {
  it("an unknown status or gender is a 400, not a database error", () => {
    for (const cls of [CreateClientDto, UpdateClientDto, AdminCreateClientDto, AdminUpdateClientDto]) {
      const body = { firstName: "Ana", lastName: "Ruiz", status: "vip", gender: "f" };
      expect(errorsOf(cls, body).sort()).toEqual(["gender", "status"]);
    }
  });

  it("an update accepts null for optional fields, but not for the name or the status", () => {
    for (const cls of [UpdateClientDto, AdminUpdateClientDto]) {
      expect(
        errorsOf(cls, { email: null, phone: null, dateOfBirth: null, gender: null, notes: null, taxId: null, taxIdType: null }),
      ).toEqual([]);
      expect(errorsOf(cls, { firstName: null, status: null }).sort()).toEqual(["firstName", "status"]);
    }
  });

  it("the admin DTOs keep the tax id and its type (the panel edits through them)", () => {
    for (const cls of [AdminCreateClientDto, AdminUpdateClientDto]) {
      const dto = plainToInstance(cls, { firstName: "Ana", lastName: "Ruiz", taxId: VALID_NIF, taxIdType: "nif" });
      expect(validateSync(dto, { whitelist: true })).toEqual([]);
      expect(dto).toMatchObject({ taxId: VALID_NIF, taxIdType: "nif" });
    }
  });

  it("/clients create keeps notes and status", () => {
    const dto = plainToInstance(CreateClientDto, { firstName: "Ana", lastName: "Ruiz", notes: "x", status: "blocked" });
    expect(validateSync(dto, { whitelist: true })).toEqual([]);
    expect(dto).toMatchObject({ notes: "x", status: "blocked" });
  });
});

/** A Prisma stand-in that records every call. */
function fakePrisma(clients: Record<string, any>[] = []) {
  const calls: Record<string, any[]> = { findMany: [], findFirst: [], create: [], update: [] };
  const prisma: any = {
    client: {
      findMany: async (args: any) => {
        calls.findMany.push(args);
        return clients;
      },
      findFirst: async (args: any) => {
        calls.findFirst.push(args);
        const { id, tenantId, appointments } = args.where;
        const found = clients.find((c) => c.id === id && c.tenantId === tenantId);
        if (!found) return null;
        if (appointments && !found.professionalIds?.includes(appointments.some.professionalId)) return null;
        return found;
      },
      create: async (args: any) => {
        calls.create.push(args);
        if (prisma.failWith) throw prisma.failWith;
        return { id: "new", ...args.data };
      },
      update: async (args: any) => {
        calls.update.push(args);
        if (prisma.failWith) throw prisma.failWith;
        return { id: args.where.id, ...args.data };
      },
    },
    // The salon's country, for a phone typed without a prefix.
    tenant: { findUnique: async () => ({ country: "ES" }) },
  };
  return { prisma, calls };
}

const ANA = {
  id: "c1",
  tenantId: "t1",
  email: "ana@example.com",
  status: "active",
  taxId: null,
  taxIdType: null,
  professionalIds: ["p1"],
};

describe("responses", () => {
  it("every clients / admin-clients read and write selects its columns", async () => {
    const { prisma, calls } = fakePrisma([ANA]);
    const clients = new ClientsService(prisma);
    const admin = new AdminClientsService(prisma);
    prisma.client.count = async () => 1;

    await clients.findAll("t1");
    await clients.findAllWithFilters("t1", {});
    await clients.findOne("t1", "c1");
    await clients.create("t1", { firstName: "Ana", lastName: "Ruiz" });
    await clients.update("t1", "c1", { phone: "600" });
    await admin.findAll({ tenantId: "t1", page: 1, limit: 10, search: "" });
    await admin.findOne("t1", "c1");
    await admin.search("t1", "an");
    await admin.create("t1", { firstName: "Ana", lastName: "Ruiz" });
    await admin.update("t1", "c1", { phone: "600" });

    const responses = [...calls.findMany, ...calls.create, ...calls.update];
    // The panel's own reads (not the existence checks, which select a few columns).
    const detailReads = calls.findFirst.filter((a) => a.select?.appointments);
    expect(detailReads).toHaveLength(2);
    for (const args of [...responses, ...detailReads]) {
      expect(args.select).toBeDefined();
      expect(args.include).toBeUndefined();
      for (const secret of CLIENT_SECRET_COLUMNS) expect(args.select[secret]).toBeUndefined();
    }
    for (const args of calls.findMany) {
      for (const column of CLIENT_HEALTH_COLUMNS) expect(args.select[column]).toBeUndefined();
    }
    for (const args of detailReads) {
      expect(args.select.allergies).toBe(true);
      expect(args.select.appointments.select.totalAmount).toBe(true);
    }
  });

  it("a taken email is a 409 on create and update, on both paths", async () => {
    const { prisma } = fakePrisma([ANA]);
    prisma.failWith = p2002();
    const clients = new ClientsService(prisma);
    const admin = new AdminClientsService(prisma);
    await expect(clients.create("t1", { firstName: "A", lastName: "B", email: "x@y.es" })).rejects.toThrow(ConflictException);
    await expect(clients.update("t1", "c1", { email: "x@y.es" })).rejects.toThrow(ConflictException);
    await expect(admin.create("t1", { firstName: "A", lastName: "B", email: "x@y.es" })).rejects.toThrow(ConflictException);
    await expect(admin.update("t1", "c1", { email: "x@y.es" })).rejects.toThrow(ConflictException);
  });

  it("the admin update stores the NIF and its type", async () => {
    const { prisma, calls } = fakePrisma([ANA]);
    await new AdminClientsService(prisma).update("t1", "c1", { taxId: "12345678-z", taxIdType: "nif" });
    expect(calls.update[0].data).toMatchObject({ taxId: VALID_NIF, taxIdType: "nif" });
  });

  it("the admin update rejects a malformed NIF, and takes a passport as typed", async () => {
    const { prisma, calls } = fakePrisma([ANA]);
    const admin = new AdminClientsService(prisma);
    await expect(admin.update("t1", "c1", { taxId: "123", taxIdType: "nif" })).rejects.toThrow(BadRequestException);
    await admin.update("t1", "c1", { taxId: "pa123", taxIdType: "passport" });
    expect(calls.update[0].data).toMatchObject({ taxId: "PA123", taxIdType: "passport" });
  });
});

describe("staff reach only their own clients", () => {
  function controllerFor(professional: { id: string } | null, clients = [ANA]) {
    const { prisma, calls } = fakePrisma(clients);
    const service = new ClientsService(prisma);
    const professionals: any = { getProfessionalByUserId: async () => professional };
    return { controller: new ClientsController(service, professionals), calls };
  }
  const staff = { id: "u1", tenantId: "t1", role: UserRole.staff };
  const owner = { id: "u0", tenantId: "t1", role: UserRole.owner };

  it("a staff user with no professional record gets an empty list and 404s", async () => {
    const { controller, calls } = controllerFor(null);
    expect(await controller.findAll(staff)).toEqual([]);
    expect(calls.findMany).toHaveLength(0);
    await expect(controller.findOne(staff, "c1")).rejects.toThrow(NotFoundException);
    await expect(controller.update(staff, "c1", { phone: "600" })).rejects.toThrow(NotFoundException);
  });

  it("the list is narrowed to clients with an appointment with them; the tenant is the caller's", async () => {
    const { controller, calls } = controllerFor({ id: "p1" });
    await controller.findAll(staff);
    expect(calls.findMany[0].where).toEqual({
      tenantId: "t1",
      appointments: { some: { professionalId: "p1" } },
    });
    await controller.findAll(owner);
    expect(calls.findMany[1].where).toEqual({ tenantId: "t1" });
  });

  it("another professional's client is a 404 to read and to edit", async () => {
    const { controller } = controllerFor({ id: "p2" });
    await expect(controller.findOne(staff, "c1")).rejects.toThrow(NotFoundException);
    await expect(controller.update(staff, "c1", { phone: "600" })).rejects.toThrow(NotFoundException);
  });

  it("their own client: they read her file and edit her details", async () => {
    const { controller, calls } = controllerFor({ id: "p1" });
    await controller.findOne(staff, "c1");
    await controller.update(staff, "c1", { phone: "600", notes: "Rubio" });
    expect(calls.update[0].data).toMatchObject({ phone: "600", notes: "Rubio" });
  });

  it("but not her email or her status (sending them unchanged is fine)", async () => {
    const { controller, calls } = controllerFor({ id: "p1" });
    await expect(controller.update(staff, "c1", { email: "other@example.com" })).rejects.toThrow(ForbiddenException);
    await expect(controller.update(staff, "c1", { email: null })).rejects.toThrow(ForbiddenException);
    await expect(controller.update(staff, "c1", { status: "blocked" })).rejects.toThrow(ForbiddenException);
    expect(calls.update).toHaveLength(0);
    await controller.update(staff, "c1", { email: "ana@example.com", status: "active", phone: "1" });
    expect(calls.update).toHaveLength(1);
  });

  it("an owner may change both", async () => {
    const { controller, calls } = controllerFor(null);
    await controller.update(owner, "c1", { email: "other@example.com", status: "blocked" });
    expect(calls.update[0].data).toMatchObject({ email: "other@example.com", status: "blocked" });
  });

  it("a client staff create starts active whatever the body says", async () => {
    const { controller, calls } = controllerFor({ id: "p1" });
    await controller.create(staff, { firstName: "Ana", lastName: "Ruiz", status: "blocked" });
    expect(calls.create[0].data.status).toBe("active");
    await controller.create(owner, { firstName: "Ana", lastName: "Ruiz", status: "blocked" });
    expect(calls.create[1].data.status).toBe("blocked");
  });
});

describe("one email and one phone however they were typed", () => {
  it("both paths store the email in lower case and the phone in international form", async () => {
    const { prisma, calls } = fakePrisma([ANA]);
    const clients = new ClientsService(prisma);
    const admin = new AdminClientsService(prisma);

    await clients.create("t1", { firstName: "Eva", lastName: "Gil", email: " Eva@Mail.ES ", phone: "600 111 222" });
    await admin.create("t1", { firstName: "Eva", lastName: "Gil", email: "EVA@mail.es", phone: "0034 600-111-222" });
    await admin.update("t1", "c1", { email: "Nueva@Mail.ES", phone: "+34 611 222 333" });

    expect(calls.create.map((c) => [c.data.email, c.data.phone])).toEqual([
      ["eva@mail.es", "+34600111222"],
      ["eva@mail.es", "+34600111222"],
    ]);
    expect(calls.update[0].data).toMatchObject({ email: "nueva@mail.es", phone: "+34611222333" });
  });

  it("the stored email sent back in other capitals is not a change (staff may send it)", async () => {
    const { prisma, calls } = fakePrisma([{ ...ANA, email: "Ana@Example.com" }]);
    const controller = new ClientsController(new ClientsService(prisma), {
      getProfessionalByUserId: async () => ({ id: "p1" }),
    } as any);
    await controller.update({ id: "u1", tenantId: "t1", role: UserRole.staff }, "c1", {
      email: "ANA@example.COM",
      notes: "x",
    });
    expect(calls.update[0].data.email).toBeUndefined();
    expect(calls.update[0].data.notes).toBe("x");
  });
});
