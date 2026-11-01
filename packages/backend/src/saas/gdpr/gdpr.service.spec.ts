/**
 * Tests for the GDPR data export + anonymize endpoints.
 *
 * Uses an in-memory Prisma mock so no DB is needed.
 */

import { gunzipSync } from "zlib";
import { Prisma } from "@prisma/client";
import { GdprService, TENANT_SECRET_FIELDS } from "./gdpr.service";
import { CLIENT_SECRET_COLUMNS } from "../../clients/client-select";
import { ANONYMIZED_FIRST_NAME, ANONYMIZED_LAST_NAME } from "../../clients/client-anonymize";

function makePrismaMock() {
  const tenants = new Map<string, any>();
  const users: any[] = [];
  const clients: any[] = [];
  const invoices: any[] = [];
  const appointments: any[] = [];
  const services: any[] = [];
  const professionals: any[] = [];
  const notifications: any[] = [];
  const accountingConnections: any[] = [];
  const reviews: any[] = [];
  const consents: any[] = [];
  const gdprRequests: any[] = [];
  const counters = { gdprRequest: 0 };

  const prisma: any = {
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
      updateMany: async (args: any) => { for (const u of users) if (u.tenantId === args.where.tenantId) Object.assign(u, args.data); return { count: users.length }; },
      findMany: async (args: any) => users.filter((u) => u.tenantId === args.where.tenantId),
      update: async (args: any) => {
        const u = users.find((x) => x.id === args.where.id);
        if (!u) throw new Error("not found");
        Object.assign(u, args.data);
        return u;
      },
    },
    client: {
      updateMany: async (args: any) => { for (const c of clients) if (c.tenantId === args.where.tenantId) Object.assign(c, args.data); return { count: clients.length }; },
      findMany: async (args: any) => clients.filter((c) => c.tenantId === args.where.tenantId),
    },
    invoice: {
      updateMany: async (args: any) => { for (const i of invoices) if (i.tenantId === args.where.tenantId) Object.assign(i, args.data); return { count: invoices.length }; },
      findMany: async (args: any) => invoices.filter((i) => i.tenantId === args.where.tenantId).map((i) => ({ ...i, lines: [] })),
    },
    appointment: { findMany: async (args: any) => appointments.filter((a) => a.tenantId === args.where.tenantId) },
    service: { findMany: async (args: any) => services.filter((s) => s.tenantId === args.where.tenantId) },
    professional: { findMany: async (args: any) => professionals.filter((p) => p.tenantId === args.where.tenantId) },
    notification: { findMany: async (args: any) => notifications.filter((n) => n.tenantId === args.where.tenantId) },
    accountingConnection: { findMany: async (args: any) => accountingConnections.filter((c) => c.tenantId === args.where.tenantId) },
    review: { findMany: async (args: any) => reviews.filter((r) => r.tenantId === args.where.tenantId) },
    consentForm: { findMany: async (args: any) => consents.filter((c) => c.tenantId === args.where.tenantId) },
    gdprRequest: {
      create: async (args: any) => {
        counters.gdprRequest += 1;
        const row = {
          id: `gdpr-${counters.gdprRequest}`,
          createdAt: new Date(),
          completedAt: null,
          status: "processing",
          ...args.data,
        };
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
  // The models the client anonymisation also cleans (consents, chats,
  // wait-list...): nothing stored for them here.
  const stub = async () => ({ count: 0 });
  const scoped: any = new Proxy(prisma, {
    get: (target, model: string) => {
      if (model.startsWith("$")) return target[model];
      const methods = target[model] ?? {};
      return new Proxy(methods, { get: (m, method: string) => m[method] ?? stub });
    },
  });

  return {
    prisma: scoped,
    tenants,
    users,
    clients,
    invoices,
    appointments,
    services,
    professionals,
    notifications,
    accountingConnections,
    reviews,
    consents,
    gdprRequests,
  };
}

function seedTenant(m: any, id = "tenant-1") {
  m.tenants.set(id, {
    id,
    name: "Salon Demo",
    slug: "salon-demo",
    taxId: "B12345678",
    legalName: "Salon Demo S.L.",
    stripeCustomerId: "cus_test_1",
    deletedAt: null,
  });
  m.users.push({ id: "user-1", tenantId: id, email: "owner@salon.com", firstName: "Alice", lastName: "Owner", isActive: true, role: "owner" });
  m.clients.push({ id: "client-1", tenantId: id, firstName: "Bob", lastName: "Smith", email: "bob@x.com", phone: "+34", taxId: "12345678Z" });
  m.invoices.push({ id: "invoice-1", tenantId: id, series: "A", number: "000001", recipientName: "Bob Smith", recipientTaxId: "12345678Z", totalCents: 12100, fiscalXml: "<signed>...</signed>" });
}

describe("GdprService.export", () => {
  it("returns a JSON envelope with base64-encoded gzip payload", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "export", "actor-1", "127.0.0.1");
    const buf = await svc.export("tenant-1", request.id);

    const envelope = JSON.parse(buf.toString("utf8"));
    expect(envelope.format).toBe("kira-gdpr-export-v1");
    expect(envelope.tenantId).toBe("tenant-1");
    expect(envelope.compression).toBe("gzip");
    expect(envelope.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof envelope.data).toBe("string");

    // Decode and decompress to verify content
    const compressed = Buffer.from(envelope.data, "base64");
    const decompressed = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      // Use Node's built-in zlib for the test verification
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const zlib = require("zlib");
      zlib.gunzip(compressed, (err: Error | null, result: Buffer) => {
        if (err) reject(err); else resolve(result);
      });
    });
    const payload = JSON.parse(decompressed.toString("utf8"));
    expect(payload.tenant.id).toBe("tenant-1");
    expect(payload.tenant.name).toBe("Salon Demo");
    expect(payload.users).toHaveLength(1);
    expect(payload.users[0].email).toBe("owner@salon.com");
    expect(payload.clients[0].email).toBe("bob@x.com");
    expect(payload.invoices[0].recipientName).toBe("Bob Smith");
    // Encrypted blob stripped from export
    expect(payload.invoices[0].fiscalXml).toBeUndefined();
  });

  it("records a GdprRequest with status=processing before work", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const svc = new GdprService(m.prisma as any);
    await svc.recordRequest("tenant-1", "export", "actor-1", "127.0.0.1");
    expect(m.gdprRequests).toHaveLength(1);
    expect(m.gdprRequests[0].status).toBe("processing");
  });
});

describe("GdprService.anonymize", () => {
  it("replaces user PII and sets isActive=false", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
    await svc.anonymize("tenant-1", request.id);

    const u = m.users[0];
    expect(u.firstName).toBe("[anonymized]");
    expect(u.lastName).toBe("[anonymized]");
    expect(u.email).toContain("[anonymized]");
    expect(u.isActive).toBe(false);
  });

  it("replaces client PII but keeps appointment FK references intact", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
    await svc.anonymize("tenant-1", request.id);

    const c = m.clients[0];
    expect(c.firstName).toBe(ANONYMIZED_FIRST_NAME);
    expect(c.lastName).toBe(ANONYMIZED_LAST_NAME);
    expect(c.passwordHash).toBe(null);
    expect(c.allergies).toEqual([]);
    expect(c.status).toBe("inactive");
    expect(c.email).toBe(null);
    expect(c.phone).toBe(null);
    expect(c.taxId).toBe(null);
    expect(c.id).toBe("client-1"); // FK preserved
  });

  it("preserves invoice records for fiscal compliance — only recipient PII replaced", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
    await svc.anonymize("tenant-1", request.id);

    const i = m.invoices[0];
    expect(i.id).toBe("invoice-1"); // preserved
    expect(i.recipientName).toBe("[anonymized]");
    expect(i.recipientTaxId).toBe(null);
    // Financial fields untouched (4-year retention required)
    expect(i.totalCents).toBe(12100);
    expect(i.series).toBe("A");
    expect(i.number).toBe("000001");
  });

  it("marks tenant as deleted + replaces NIF/email/slug", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
    await svc.anonymize("tenant-1", request.id);

    const t = m.tenants.get("tenant-1");
    expect(t.name).toContain("anonymized");
    expect(t.taxId).toBe(null);
    expect(t.legalName).toBe(null);
    expect(t.stripeCustomerId).toBe(null);
    expect(t.slug).toMatch(/^anon-/);
    expect(t.deletedAt).toBeInstanceOf(Date);
  });

  it("marks the GdprRequest as completed after anonymization", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
    await svc.anonymize("tenant-1", request.id);

    expect(m.gdprRequests[0].status).toBe("completed");
    expect(m.gdprRequests[0].completedAt).toBeInstanceOf(Date);
  });
});

describe("GdprService secrets", () => {
  it("every Tenant column that looks like a secret is left out of the export", () => {
    const secretLooking = (Object.values(Prisma.TenantScalarFieldEnum) as string[]).filter((c) =>
      /secret|password|token|hash|private/i.test(c),
    );
    expect(secretLooking.filter((c) => !(TENANT_SECRET_FIELDS as readonly string[]).includes(c))).toEqual([]);
  });

  it("the export carries no client sign-in secret and no Stripe secret key", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    Object.assign(m.tenants.get("tenant-1"), { stripeTestSecretKey: "sk_test_x", stripeLiveSecretKey: "sk_live_x", stripeTestPublishableKey: "pk_test_x" });
    Object.assign(m.clients[0], { passwordHash: "$2b$hash", passwordResetToken: "tok", passwordResetExpires: new Date(), tokenVersion: 3 });
    const svc = new GdprService(m.prisma as any);
    const envelope = JSON.parse((await svc.export("tenant-1", "req-1")).toString("utf8"));
    const payload = JSON.parse(gunzipSync(Buffer.from(envelope.data, "base64")).toString("utf8"));
    for (const column of CLIENT_SECRET_COLUMNS) expect(payload.clients[0]).not.toHaveProperty(column);
    for (const column of TENANT_SECRET_FIELDS) expect(payload.tenant).not.toHaveProperty(column);
    expect(payload.tenant.stripeTestPublishableKey).toBe("pk_test_x");
    expect(payload.clients[0].email).toBe("bob@x.com");
  });

  it("anonymize gives each user their own placeholder email and drops the Stripe secret keys", async () => {
    const m = makePrismaMock();
    seedTenant(m);
    m.users.push({ id: "user-2", tenantId: "tenant-1", email: "staff@salon.com", firstName: "Eva", lastName: "Staff", isActive: true, role: "staff" });
    Object.assign(m.tenants.get("tenant-1"), { stripeLiveSecretKey: "sk_live_x" });
    const svc = new GdprService(m.prisma as any);
    const request = await svc.recordRequest("tenant-1", "anonymize", "actor-1", undefined);
    await svc.anonymize("tenant-1", request.id);
    const emails = m.users.map((u: any) => u.email);
    expect(new Set(emails).size).toBe(2);
    for (const e of emails) expect(e).toContain("@deleted.local");
    expect(m.tenants.get("tenant-1").stripeLiveSecretKey).toBe(null);
  });
});

describe("GdprService.recordRequest", () => {
  it("captures actor + ip + initial status", async () => {
    const m = makePrismaMock();
    const svc = new GdprService(m.prisma as any);
    const r = await svc.recordRequest("tenant-1", "export", "actor-xyz", "10.0.0.1");
    expect(r.status).toBe("processing");
    expect(r.actorId).toBe("actor-xyz");
    expect(r.ipAddress).toBe("10.0.0.1");
    expect(r.tenantId).toBe("tenant-1");
  });
});
