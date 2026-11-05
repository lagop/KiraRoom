/**
 * Tests for the GDPR data export + anonymize endpoints.
 *
 * Uses an in-memory Prisma mock so no DB is needed.
 */

import { gunzipSync } from "zlib";
import { Prisma } from "@prisma/client";
import {
  EXPORT_GLOBAL_MODELS,
  EXPORT_OMITTED_COLUMNS,
  EXPORT_SECRET_LOOKALIKES_KEPT,
  GdprService,
  TENANT_MODEL_ON_ERASURE,
  TENANT_SECRET_FIELDS,
  tenantScope,
} from "./gdpr.service";
import { CLIENT_SECRET_COLUMNS } from "../../clients/client-select";
import { ANONYMIZED_FIRST_NAME, ANONYMIZED_LAST_NAME } from "../../clients/client-anonymize";

type Call = { model: string; method: string; args: any };

function makePrismaMock() {
  const tenants = new Map<string, any>();
  const users: any[] = [];
  const clients: any[] = [];
  const invoices: any[] = [];
  const professionals: any[] = [];
  const gdprRequests: any[] = [];
  const calls: Call[] = [];
  const counters = { gdprRequest: 0 };

  const auditLogs: any[] = [];
  const prisma: any = {
    // Audit 8, C15: the salon's audit rows are scrubbed on anonymisation.
    tenantInvite: { findMany: async () => [] },
    auditLog: {
      findMany: async (args: any) => auditLogs.filter((r) => r.tenantId === args.where.OR[0].tenantId),
      update: async (args: any) => Object.assign(auditLogs.find((r) => r.id === args.where.id), args.data),
    },
    tenant: {
      findUnique: async (args: any) => tenants.get(args.where.id) ?? null,
      update: async (args: any) => {
        const cur = tenants.get(args.where.id);
        if (!cur) throw new Error("not found");
        Object.assign(cur, args.data);
        return cur;
      },
    },
    user: {
      findMany: async (args: any) => users.filter((u) => u.tenantId === args.where.tenantId),
      update: async (args: any) => {
        const u = users.find((x) => x.id === args.where.id);
        if (!u) throw new Error("not found");
        Object.assign(u, args.data);
        return u;
      },
    },
    client: {
      updateMany: async (args: any) => {
        for (const c of clients) if (c.tenantId === args.where.tenantId) Object.assign(c, args.data);
        return { count: clients.length };
      },
      findMany: async (args: any) => clients.filter((c) => c.tenantId === args.where.tenantId),
    },
    invoice: {
      updateMany: async (args: any) => {
        for (const i of invoices) if (i.tenantId === args.where.tenantId) Object.assign(i, args.data);
        return { count: invoices.length };
      },
      findMany: async (args: any) => invoices.filter((i) => i.tenantId === args.where.tenantId),
    },
    professional: {
      findMany: async (args: any) => professionals.filter((p) => p.tenantId === args.where.tenantId),
      update: async (args: any) => {
        const p = professionals.find((x) => x.id === args.where.id);
        Object.assign(p, args.data);
        return p;
      },
    },
    tenantLlmUsage: {
      findMany: async () => [{ id: "u1", tenantId: "tenant-1", inputTokens: BigInt(12) }],
    },
    gdprRequest: {
      create: async (args: any) => {
        counters.gdprRequest += 1;
        const row = { id: `gdpr-${counters.gdprRequest}`, createdAt: new Date(), completedAt: null, status: "processing", ...args.data };
        gdprRequests.push(row);
        return row;
      },
      update: async (args: any) => {
        const idx = gdprRequests.findIndex((r) => r.id === args.where.id);
        if (idx < 0) throw new Error("not found");
        Object.assign(gdprRequests[idx], args.data);
        return gdprRequests[idx];
      },
    },
    $transaction: async (fn: any) => fn(scoped),
  };
  // Every other table: empty, and every call recorded.
  const stub = (method: string) => async () =>
    method === "findMany" ? [] : method === "findUnique" || method === "findFirst" ? null : { count: 0 };
  const scoped: any = new Proxy(prisma, {
    get: (target, model: string) => {
      if (typeof model !== "string" || model.startsWith("$")) return target[model];
      const methods = target[model] ?? {};
      return new Proxy(methods, {
        get: (m, method: string) => {
          const fn = m[method] ?? stub(method);
          return (args: any) => {
            calls.push({ model, method, args });
            return fn(args);
          };
        },
      });
    },
  });

  return { prisma: scoped, tenants, users, clients, invoices, professionals, gdprRequests, calls };
}

function seedTenant(m: ReturnType<typeof makePrismaMock>, id = "tenant-1") {
  m.tenants.set(id, {
    id,
    name: "Salon Demo",
    slug: "salon-demo",
    taxId: "B12345678",
    legalName: "Salon Demo S.L.",
    street: "Calle Mayor 1",
    stripeCustomerId: "cus_test_1",
    instagram: "salondemo",
    features: { multichannel: { telegram: { configured: true } }, icsFeed: { version: 2 } },
    deletedAt: null,
    anonymizedAt: null,
  });
  m.users.push({ id: "user-1", tenantId: id, email: "owner@salon.com", firstName: "Alice", lastName: "Owner", phone: "600111222", isActive: true, role: "owner" });
  m.clients.push({ id: "client-1", tenantId: id, firstName: "Bob", lastName: "Smith", email: "bob@x.com", phone: "+34", taxId: "12345678Z" });
  m.invoices.push({ id: "invoice-1", tenantId: id, series: "A", number: "000001", recipientName: "Bob Smith", recipientTaxId: "12345678Z", totalCents: 12100, fiscalXml: "<signed>...</signed>" });
  m.professionals.push({ id: "pro-1", tenantId: id, firstName: "Eva", lastName: "Estilista", email: "eva@salon.com", phone: "600333444", bio: "Me encanta" });
}

async function exportPayload(svc: GdprService, tenantId = "tenant-1") {
  const envelope = JSON.parse((await svc.export(tenantId, "req-1")).toString("utf8"));
  return { envelope, payload: JSON.parse(gunzipSync(Buffer.from(envelope.data, "base64")).toString("utf8")) };
}

async function anonymized(m = makePrismaMock()) {
  seedTenant(m);
  const svc = new GdprService(m.prisma as any);
  const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
  await svc.anonymize("tenant-1", request.id);
  return m;
}

const MODELS = Prisma.dmmf.datamodel.models;
const TENANT_MODELS = MODELS.filter((m) => m.fields.some((f) => f.name === "tenantId")).map((m) => m.name);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

describe("GdprService.export", () => {
  it("returns a JSON envelope with base64-encoded gzip payload of every table", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const { envelope, payload } = await exportPayload(new GdprService(m.prisma as any));
    expect(envelope.format).toBe("kira-gdpr-export-v1");
    expect(envelope.compression).toBe("gzip");
    expect(envelope.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.tenant.id).toBe("tenant-1");
    expect(payload.tables.User[0].email).toBe("owner@salon.com");
    expect(payload.tables.Client[0].email).toBe("bob@x.com");
    expect(payload.tables.Invoice[0].recipientName).toBe("Bob Smith");
    expect(payload.tables.Invoice[0].fiscalXml).toBeUndefined();
    // Signed consents and their forms: two tables, each under its own name (T11).
    expect(payload.tables).toHaveProperty("Consent");
    expect(payload.tables).toHaveProperty("ConsentForm");
    // BigInt counters are written as text.
    expect(payload.tables.TenantLlmUsage[0].inputTokens).toBe("12");
  });

  it("reads every table of the salon: by tenantId, or through its parent (audit 8 T11)", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const { payload } = await exportPayload(new GdprService(m.prisma as any));
    const expected = MODELS.map((x) => x.name).filter(
      (n) => n !== "Tenant" && !(EXPORT_GLOBAL_MODELS as readonly string[]).includes(n),
    );
    expect(Object.keys(payload.tables).sort()).toEqual(expected.sort());
    const reads = m.calls.filter((c) => c.method === "findMany");
    expect(reads.find((c) => c.model === "chatMessage")!.args.where).toEqual({ conversation: { tenantId: "tenant-1" } });
    expect(reads.find((c) => c.model === "loyaltyRedemption")!.args.where).toEqual({ member: { client: { tenantId: "tenant-1" } } });
    expect(reads.find((c) => c.model === "invoiceLine")!.args.where).toEqual({ invoice: { tenantId: "tenant-1" } });
  });

  it("only platform-wide tables have no way to the salon", () => {
    const unscoped = MODELS.map((x) => x.name).filter((n) => n !== "Tenant" && !tenantScope(n, "t"));
    expect(unscoped.sort()).toEqual([...EXPORT_GLOBAL_MODELS].sort());
  });

  it("records a GdprRequest with status=processing before work", async () => {
    const m = makePrismaMock();
    const svc = new GdprService(m.prisma as any);
    await svc.recordRequest("tenant-1", "export", "actor-1", "127.0.0.1");
    expect(m.gdprRequests[0].status).toBe("processing");
  });

  it("marks requests completed or failed (audit 8 T12)", async () => {
    const m = makePrismaMock();
    const svc = new GdprService(m.prisma as any);
    const a = await svc.recordRequest("tenant-1", "export", "actor-1", undefined);
    const b = await svc.recordRequest("tenant-1", "export", "actor-1", undefined);
    await svc.completeRequest(a.id);
    await svc.failRequest(b.id, new Error("boom"));
    expect(m.gdprRequests[0].status).toBe("completed");
    expect(m.gdprRequests[0].completedAt).toBeInstanceOf(Date);
    expect(m.gdprRequests[1].status).toBe("failed");
    expect(m.gdprRequests[1].notes).toContain("boom");
  });
});

describe("GdprService.anonymize", () => {
  it("replaces user PII, phone and secrets, and revokes their sessions", async () => {
    const m = await anonymized();
    const u = m.users[0];
    expect(u.firstName).toBe("[anonymized]");
    expect(u.email).toContain("[anonymized]");
    expect(u.phone).toBe(null);
    expect(u.twoFactorSecret).toBe(null);
    expect(u.isActive).toBe(false);
    const sessions = m.calls.find((c) => c.model === "authSession")!;
    expect(sessions.args.where).toMatchObject({ subjectType: "user", subjectId: { in: ["user-1"] } });
  });

  it("strips the personal data of the salon's bug reports and its users' (audit 8 D14)", async () => {
    const m = await anonymized();
    const call = m.calls.find((c) => c.model === "bugReport" && c.args?.data?.anonymizedAt)!;
    expect(call.args.where).toEqual({ anonymizedAt: null, OR: [{ tenantId: "tenant-1" }, { authorId: { in: ["user-1"] } }] });
    expect(call.args.data).toMatchObject({ subject: "[eliminado]", description: "[eliminado]", email: null, currentUrl: null });
    expect(call.args.data.anonymizedAt).toBeInstanceOf(Date);
  });

  it("anonymises the team (Professional)", async () => {
    const m = await anonymized();
    const p = m.professionals[0];
    expect(p.firstName).toBe("[anonymized]");
    expect(p.email).toContain("@deleted.local");
    expect(p.phone).toBe(null);
    expect(p.bio).toBe(null);
  });

  it("replaces client PII but keeps the client row", async () => {
    const m = await anonymized();
    const c = m.clients[0];
    expect(c.firstName).toBe(ANONYMIZED_FIRST_NAME);
    expect(c.lastName).toBe(ANONYMIZED_LAST_NAME);
    expect(c.email).toBe(null);
    expect(c.id).toBe("client-1");
  });

  it("deletes every conversation of the salon, also with visitors who never booked", async () => {
    const m = await anonymized();
    const chats = m.calls.filter((c) => c.model === "chatConversation" && c.method === "deleteMany");
    expect(chats.some((c) => JSON.stringify(c.args.where) === JSON.stringify({ tenantId: "tenant-1" }))).toBe(true);
    expect(m.calls.some((c) => c.model === "assistantConversation" && c.method === "deleteMany")).toBe(true);
  });

  it("never touches the issued invoices, nor the salon's NIF, razón social and address (audit 8 T5)", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const before = { ...m.invoices[0] };
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
    // Without keepFiscalData: the console's erasure used to wipe the recipients.
    await svc.anonymize("tenant-1", request.id);
    expect(m.invoices[0]).toEqual(before);
    expect(m.calls.some((c) => c.model === "invoice" && c.method !== "findMany")).toBe(false);
    const t = m.tenants.get("tenant-1");
    expect(t.taxId).toBe("B12345678");
    expect(t.legalName).toBe("Salon Demo S.L.");
    expect(t.street).toBe("Calle Mayor 1");
  });

  it("marks the tenant deleted and anonymised, empties its profile and channel credentials", async () => {
    const m = await anonymized();
    const t = m.tenants.get("tenant-1");
    expect(t.name).toContain("anonymized");
    expect(t.slug).toMatch(/^anon-/);
    expect(t.stripeCustomerId).toBe(null);
    expect(t.instagram).toBe(null);
    expect(t.deletedAt).toBeInstanceOf(Date);
    expect(t.anonymizedAt).toBeInstanceOf(Date);
    expect(t.features).toEqual({ icsFeed: { version: 3 } });
  });

  it("keeps the first deletion and anonymisation dates", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const first = new Date("2026-01-01T00:00:00Z");
    Object.assign(m.tenants.get("tenant-1"), { deletedAt: first, anonymizedAt: first });
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
    await svc.anonymize("tenant-1", request.id);
    expect(m.tenants.get("tenant-1").deletedAt).toBe(first);
    expect(m.tenants.get("tenant-1").anonymizedAt).toBe(first);
  });

  it("marks the GdprRequest as completed", async () => {
    const m = await anonymized();
    expect(m.gdprRequests[0].status).toBe("completed");
  });

  it("gives each user their own placeholder email and drops the Stripe secret keys", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    m.users.push({ id: "user-2", tenantId: "tenant-1", email: "staff@salon.com", firstName: "Eva", lastName: "Staff", isActive: true, role: "staff" });
    Object.assign(m.tenants.get("tenant-1"), { stripeLiveSecretKey: "sk_" + "live_x" });
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
    await svc.anonymize("tenant-1", request.id);
    expect(new Set(m.users.map((u: any) => u.email)).size).toBe(2);
    expect(m.tenants.get("tenant-1").stripeLiveSecretKey).toBe(null);
  });
});

describe("TENANT_MODEL_ON_ERASURE (audit 8 T11 checklist)", () => {
  it("has a decision for every table with a tenantId, and only for those", () => {
    expect(Object.keys(TENANT_MODEL_ON_ERASURE).sort()).toEqual([...TENANT_MODELS].sort());
  });

  it("every table marked deleted or cleaned is written for this salon; none marked kept is deleted", async () => {
    const m = await anonymized();
    const writes = m.calls.filter((c) => /^(update|updateMany|deleteMany)$/.test(c.method));
    const viaCampaign: Record<string, string> = {
      EmailCampaign: "emailCampaignRecipient",
      WhatsAppCampaign: "whatsAppCampaignRecipient",
    };
    const missing = Object.entries(TENANT_MODEL_ON_ERASURE)
      .filter(([, d]) => d === "deleted" || d === "cleaned")
      .map(([model]) => model)
      .filter((model) => {
        if (viaCampaign[model]) {
          return !writes.some((c) => c.model === viaCampaign[model] && c.args.where.campaign?.tenantId === "tenant-1");
        }
        if (model === "User" || model === "Professional") {
          return !writes.some((c) => c.model === lower(model) && c.method === "update");
        }
        return !writes.some((c) => c.model === lower(model) && c.args?.where?.tenantId === "tenant-1");
      });
    expect(missing).toEqual([]);
    const deleted = new Set(writes.filter((c) => c.method === "deleteMany").map((c) => c.model));
    const keptButDeleted = Object.entries(TENANT_MODEL_ON_ERASURE)
      .filter(([model, d]) => d === "kept" && deleted.has(lower(model)))
      .map(([model]) => model);
    expect(keptButDeleted).toEqual([]);
  });
});

describe("GdprService secrets", () => {
  it("every Tenant column that looks like a secret is left out of the export", () => {
    const secretLooking = (Object.values(Prisma.TenantScalarFieldEnum) as string[]).filter((c) =>
      /secret|password|token|hash|private/i.test(c),
    );
    expect(secretLooking.filter((c) => !(TENANT_SECRET_FIELDS as readonly string[]).includes(c))).toEqual([]);
  });

  it("every column of any table that looks like a secret is omitted or explicitly kept", () => {
    const flagged: string[] = [];
    for (const m of MODELS) {
      if ((EXPORT_GLOBAL_MODELS as readonly string[]).includes(m.name)) continue;
      for (const f of m.fields) {
        if (f.kind === "object") continue;
        if (!/secret|password|token|hash|private|enc$|encrypted|cipher|pem|jti|key/i.test(f.name)) continue;
        const omitted = (EXPORT_OMITTED_COLUMNS[m.name] ?? []).includes(f.name);
        if (!omitted && !EXPORT_SECRET_LOOKALIKES_KEPT[`${m.name}.${f.name}`]) flagged.push(`${m.name}.${f.name}`);
      }
    }
    expect(flagged).toEqual([]);
  });

  it("the export carries no client sign-in secret, no Stripe secret key, no channel credentials", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    Object.assign(m.tenants.get("tenant-1"), {
      stripeTestSecretKey: "sk_" + "test_x",
      stripeLiveSecretKey: "sk_" + "live_x",
      stripeTestPublishableKey: "pk_test_x",
    });
    Object.assign(m.clients[0], { passwordHash: "$2b$hash", passwordResetToken: "tok", passwordResetExpires: new Date(), tokenVersion: 3 });
    const { payload } = await exportPayload(new GdprService(m.prisma as any));
    for (const column of CLIENT_SECRET_COLUMNS) expect(payload.tables.Client[0]).not.toHaveProperty(column);
    for (const column of TENANT_SECRET_FIELDS) expect(payload.tenant).not.toHaveProperty(column);
    expect(payload.tenant).not.toHaveProperty("features");
    expect(payload.tenant.stripeTestPublishableKey).toBe("pk_test_x");
  });
});
