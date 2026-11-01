import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  CLIENT_REFERENCES,
  ClientMergeService,
  MERGE_SAME_CLIENT,
  MERGE_SOURCE_BLOCKED,
  MERGE_TARGET_INACTIVE,
  mergeNotes,
  mergePreferences,
  unionList,
} from "./client-merge.service";

/**
 * Every column that can hold a client's id, read from the Prisma schema:
 *
 * - the foreign key of every relation to Client (Appointment.clientId, ...);
 * - every other text column named like a client id (Consent.clientId,
 *   Review.clientId, ... have no relation in the schema);
 * - the ones that hold one under another name, listed by hand below.
 */
const POLYMORPHIC = ["AuthSession.subjectId", "Invoice.recipientId", "GiftCard.purchasedById", "GiftCard.recipientId"];

function clientReferencesInSchema(): string[] {
  const found = new Set<string>();
  for (const model of Prisma.dmmf.datamodel.models) {
    if (model.name === "Client") continue;
    for (const field of model.fields) {
      if (field.kind === "object" && field.type === "Client") {
        for (const fk of field.relationFromFields ?? []) found.add(`${model.name}.${fk}`);
      }
      if (field.kind === "scalar" && field.type === "String" && /client/i.test(field.name)) {
        found.add(`${model.name}.${field.name}`);
      }
    }
  }
  return [...found].sort();
}

describe("client merge: every reference to a client is handled", () => {
  it("lists every column of the schema that points at a client", () => {
    const unhandled = clientReferencesInSchema().filter((ref) => !(ref in CLIENT_REFERENCES));
    // A new relation to Client (or a new *clientId column) must be moved by
    // ClientMergeService.mergeIn and listed in CLIENT_REFERENCES; otherwise
    // merging fails on it (Restrict) or it is deleted with the source.
    expect(unhandled).toEqual([]);
  });

  it("lists nothing the schema no longer has", () => {
    const fields = new Set(
      Prisma.dmmf.datamodel.models.flatMap((m) => m.fields.map((f) => `${m.name}.${f.name}`)),
    );
    expect(Object.keys(CLIENT_REFERENCES).filter((ref) => !fields.has(ref))).toEqual([]);
    for (const ref of POLYMORPHIC) expect(CLIENT_REFERENCES[ref]).toBeDefined();
  });

  it("every relation the Client model declares is among them", () => {
    const client = Prisma.dmmf.datamodel.models.find((m) => m.name === "Client")!;
    for (const field of client.fields.filter((f) => f.kind === "object" && f.type !== "Tenant")) {
      const other = Prisma.dmmf.datamodel.models.find((m) => m.name === field.type)!;
      const back = other.fields.find((f) => f.relationName === field.relationName && f.type === "Client")!;
      for (const fk of back.relationFromFields ?? []) {
        expect(CLIENT_REFERENCES[`${other.name}.${fk}`]).toBeDefined();
      }
    }
  });
});

describe("merging the fields of two records", () => {
  it("joins lists without repeating an item", () => {
    expect(unionList(["vip", "rubio"], ["rubio", "alergia"])).toEqual(["vip", "rubio", "alergia"]);
    expect(unionList(null, [{ a: 1 }, { a: 1 }])).toEqual([{ a: 1 }]);
    expect(unionList("not a list" as any, ["x"])).toEqual(["x"]);
  });

  it("keeps an opt-out from either record", () => {
    expect(
      mergePreferences(
        { whatsapp: true, email: true, reminder: { sms: true, email: false } },
        { whatsapp: false, push: true, reminder: { sms: false, email: true } },
      ),
    ).toEqual({ whatsapp: false, email: true, push: true, reminder: { sms: false, email: false } });
    expect(mergePreferences(null, { email: false })).toEqual({ email: false });
  });

  it("puts both notes together, the target's first", () => {
    expect(mergeNotes("Rubio", "Alérgica al tinte")).toBe("Rubio\n\nAlérgica al tinte");
    expect(mergeNotes("Rubio", "Rubio")).toBe("Rubio");
    expect(mergeNotes(null, " x ")).toBe("x");
    expect(mergeNotes("", null)).toBeNull();
  });
});

describe("what may be merged", () => {
  const actor = { id: "u1", role: "owner" as any };

  function build(clients: Record<string, { status: string } | undefined>) {
    const tx: any = {
      $queryRaw: jest.fn(async () => []),
      client: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.tenantId === "t1" && clients[where.id] ? { id: where.id, ...clients[where.id] } : null,
        ),
      },
    };
    const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    const audit: any = { record: jest.fn() };
    return { service: new ClientMergeService(prisma, audit), prisma };
  }

  it("not a record into itself", async () => {
    const { service, prisma } = build({ a: { status: "active" } });
    await expect(service.merge("t1", "a", "a", actor)).rejects.toThrow(new BadRequestException(MERGE_SAME_CLIENT));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("only two clients of the caller's salon (another salon's is a 404)", async () => {
    const { service } = build({ a: { status: "active" } });
    await expect(service.merge("t1", "a", "elsewhere", actor)).rejects.toThrow(NotFoundException);
    await expect(service.merge("t1", "elsewhere", "a", actor)).rejects.toThrow(NotFoundException);
  });

  it("not into a deactivated record", async () => {
    const { service } = build({ a: { status: "inactive" }, b: { status: "active" } });
    await expect(service.merge("t1", "a", "b", actor)).rejects.toThrow(new ConflictException(MERGE_TARGET_INACTIVE));
  });

  it("not a blocked record into one that is not (the block would be lost)", async () => {
    const { service } = build({ a: { status: "active" }, b: { status: "blocked" } });
    await expect(service.merge("t1", "a", "b", actor)).rejects.toThrow(new ConflictException(MERGE_SOURCE_BLOCKED));
  });
});
