import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ClientGdprService } from "./client-gdpr.service";
import { CLIENT_SECRET_COLUMNS } from "./client-select";
import * as anonymizer from "./client-anonymize";

const TENANT = "tenant-1";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const actor = { id: "user-1", role: "owner" as const };

const her = {
  id: CLIENT,
  tenantId: TENANT,
  firstName: "Ana",
  lastName: "López",
  email: "ana@example.com",
  phone: "+34600112233",
  allergies: ["látex"],
  passwordHash: "$2b$10$secret",
};

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

/** A Prisma mock: answers from `data[model][method]`, records every call. */
function prismaMock(data: Record<string, Record<string, any>> = {}) {
  const calls: { model: string; method: string; args: any }[] = [];
  const prisma: any = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === "$transaction") return async (fn: any) => fn(prisma);
        return new Proxy(
          {},
          {
            get(_m, method: string) {
              return async (args: any) => {
                calls.push({ model, method, args });
                const answer = data[model]?.[method];
                if (typeof answer === "function") return answer(args);
                if (answer !== undefined) return answer;
                if (method === "findMany") return [];
                if (method === "count") return 0;
                if (method.endsWith("Many")) return { count: 0 };
                return null;
              };
            },
          },
        );
      },
    },
  );
  return { prisma, calls };
}

function service(data: Record<string, Record<string, any>> = {}) {
  const { prisma, calls } = prismaMock(data);
  const audit = { record: jest.fn(async () => ({ id: "audit-1" })) };
  return { svc: new ClientGdprService(prisma, audit as any), calls, audit };
}

describe("ClientGdprService.export", () => {
  const data = {
    client: { findFirst: (args: any) => (args.where.tenantId === TENANT && args.where.id === CLIENT ? her : null) },
    tenant: { findUnique: { name: "Salón Demo", legalName: "Salón Demo S.L.", taxId: "B12345678" } },
    giftCard: {
      findMany: [
        { code: "GIFT-AAAA-1111", recipientId: CLIENT, purchasedById: null, recipientName: "Ana", recipientEmail: "ana@example.com", message: "¡Felicidades!", initialAmount: 5000, currentBalance: 5000 },
        { code: "GIFT-BBBB-2222", recipientId: null, purchasedById: CLIENT, recipientName: "Marta Ruiz", recipientEmail: "marta@example.com", message: "Para ti", initialAmount: 3000, currentBalance: 0 },
      ],
    },
    consent: {
      findMany: [
        { signedAt: new Date("2026-01-01"), revokedAt: new Date("2026-02-01"), responses: { accepts: true }, form: { name: "Comunicaciones comerciales", purpose: "marketing" } },
        { signedAt: new Date("2026-02-01"), revokedAt: null, responses: { accepts: false }, form: { name: "Comunicaciones comerciales", purpose: "marketing" } },
        { signedAt: new Date("2026-03-01"), revokedAt: null, responses: { q1: "no" }, formSnapshot: [], signatureName: "Ana López", form: { name: "Láser", purpose: "service" } },
      ],
    },
  };

  it("never carries her sign-in secrets", async () => {
    const { svc } = service(data);
    const doc = await svc.export(TENANT, CLIENT, actor);
    const keys = keysOf(doc);
    for (const secret of [...CLIENT_SECRET_COLUMNS, "reviewToken"]) expect(keys.has(secret)).toBe(false);
    expect(JSON.stringify(doc)).not.toContain("$2b$10$secret");
    expect(doc.client).toMatchObject({ firstName: "Ana", allergies: ["látex"], hasOnlineAccount: true });
  });

  it("covers every model that points at a client", async () => {
    const { svc, calls } = service(data);
    await svc.export(TENANT, CLIENT, actor);
    const queried = new Set(calls.map((c) => c.model));
    const linked = Prisma.dmmf.datamodel.models
      .filter((m) => m.name !== "Client")
      .filter((m) => m.fields.some((f) => f.name === "clientId" || (f.kind === "object" && f.type === "Client" && !f.isList)))
      .map((m) => m.name.charAt(0).toLowerCase() + m.name.slice(1));
    expect(linked.filter((m) => !queried.has(m))).toEqual([]);
  });

  it("reads only the salon's data", async () => {
    const { svc, calls } = service(data);
    await svc.export(TENANT, CLIENT, actor);
    for (const c of calls) {
      if (c.model === "tenant" || c.model === "promotionUsage") continue; // by the tenant's id / her id, checked above
      const where = c.args.where;
      const scoped = where.tenantId === TENANT || where.campaign?.tenantId === TENANT || where.client?.tenantId === TENANT;
      expect({ call: `${c.model}.${c.method}`, scoped }).toEqual({ call: `${c.model}.${c.method}`, scoped: true });
    }
  });

  it("only invoices made out to her", async () => {
    const { svc, calls } = service(data);
    await svc.export(TENANT, CLIENT, actor);
    const q = calls.find((c) => c.model === "invoice")!;
    expect(q.args.where).toEqual({ tenantId: TENANT, recipientType: "client", recipientId: CLIENT });
    expect(Object.keys(q.args.select)).not.toContain("fiscalXml");
  });

  it("gift cards: codes masked, and another person's details left out", async () => {
    const { svc } = service(data);
    const doc = await svc.export(TENANT, CLIENT, actor);
    expect(doc.giftCards[0]).toMatchObject({ code: "…1111", role: "recipient", recipientName: "Ana", message: "¡Felicidades!" });
    expect(doc.giftCards[1]).toMatchObject({ code: "…2222", role: "purchaser" });
    expect(JSON.stringify(doc.giftCards[1])).not.toContain("Marta");
  });

  it("marketing choices: the current one and the whole history; treatment consents apart", async () => {
    const { svc } = service(data);
    const doc = await svc.export(TENANT, CLIENT, actor);
    expect(doc.marketingConsent.email.status).toBe("refused");
    expect(doc.marketingConsent.whatsapp.status).toBe("none");
    expect(doc.marketingConsent.history.map((h: any) => h.accepts)).toEqual([true, false]);
    expect(doc.consents).toHaveLength(1);
    expect(doc.consents[0]).toMatchObject({ form: "Láser", answers: { q1: "no" } });
  });

  it("records who exported, without personal data", async () => {
    const { svc, audit } = service(data);
    await svc.export(TENANT, CLIENT, actor);
    expect(audit.record).toHaveBeenCalledWith("client.gdpr_export", {
      actorId: "user-1",
      actorRole: "owner",
      tenantId: TENANT,
      metadata: { clientId: CLIENT },
    });
  });

  it("404 for a client of another salon", async () => {
    const { svc, audit } = service(data);
    await expect(svc.export("tenant-2", CLIENT, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("ClientGdprService.anonymize", () => {
  afterEach(() => jest.restoreAllMocks());

  const found = { client: { findFirst: (args: any) => (args.where.tenantId === TENANT ? { id: CLIENT } : null) } };

  it("anonymises her in one transaction and records it", async () => {
    const spy = jest.spyOn(anonymizer, "anonymizeClients").mockResolvedValue({ clients: 1 });
    const { svc, audit } = service(found);
    await expect(svc.anonymize(TENANT, CLIENT, actor)).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith(expect.anything(), TENANT, [CLIENT]);
    expect(audit.record).toHaveBeenCalledWith(
      "client.gdpr_anonymize",
      { actorId: "user-1", actorRole: "owner", tenantId: TENANT, metadata: { clientId: CLIENT } },
      expect.anything(),
    );
  });

  it("refused while she has upcoming appointments", async () => {
    const spy = jest.spyOn(anonymizer, "anonymizeClients");
    const { svc } = service({ ...found, appointment: { count: 2 } });
    await expect(svc.anonymize(TENANT, CLIENT, actor)).rejects.toThrow(
      new ConflictException("Tiene 2 citas pendientes. Cancélalas antes de anonimizar sus datos."),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("404 for a client of another salon", async () => {
    const spy = jest.spyOn(anonymizer, "anonymizeClients");
    const { svc } = service(found);
    await expect(svc.anonymize("tenant-2", CLIENT, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(spy).not.toHaveBeenCalled();
  });
});
