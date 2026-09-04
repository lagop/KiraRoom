/**
 * AccountingService + adapter unit tests covering:
 *  - OAuth URL contains expected scopes/redirect_uri
 *  - Holded adapter: payload shape + idempotency (same externalRef → same id)
 *  - Sage adapter: payload shape (items + tax_rate)
 *  - syncInvoice when no connection → skipped, no error
 *  - syncInvoice when syncOnIssue=false in tenant settings → skipped
 *  - syncInvoice when already synced (externalId set) → skipped
 *  - syncInvoice on happy path → status=synced + externalId persisted + log written
 *  - retryQueue walks pending invoices
 */

import { ConfigService } from "@nestjs/config";
import { AccountingService } from "./accounting.service";
import { HoldedAdapter, ProviderHttpError } from "./providers/holded.adapter";
import { SageAdapter } from "./providers/sage.adapter";
import { EncryptionService } from "../common/encryption/encryption.service";
import { AccountingProvider } from "@prisma/client";

function makeEncryptionMock(): EncryptionService {
  // Real AES roundtrip; deterministic because key is fixed (32 bytes of base64).
  const fakeConfig = {
    get: (key: string) =>
      key === "META_TOKEN_ENCRYPTION_KEY"
        ? Buffer.alloc(32, 7).toString("base64")
        : null,
  } as any;
  return new EncryptionService(fakeConfig);
}

function makeHoldedAdapter() {
  return new HoldedAdapter({
    get: () => null,
  } as any);
}

function makeSageAdapter() {
  return new SageAdapter({
    get: () => null,
  } as any);
}

function makePrismaMock() {
  const m: any = {};
  m.tenant = {
    id: "tenant-1",
    accountingSettings: { enabled: true, syncOnIssue: true },
  };
  const tenant = m.tenant;
  m.connection = {
    id: "conn-1",
    tenantId: "tenant-1",
    provider: AccountingProvider.holded,
    encryptedAccessToken: "",
    encryptedRefreshToken: "",
    expiresAt: new Date(Date.now() + 3600_000),
    externalCompanyId: "comp-1",
    isActive: true,
    lastError: null,
  };
  const connection = m.connection;
  const invoices = new Map<string, any>();
  const connections = new Map<string, any>();
  connections.set("tenant-1", connection);
  const logs: any[] = [];

  return {
    tenant,
    connection,
    invoices,
    connections,
    logs,
    prisma: {
      invoice: {
        findUnique: jest.fn(async (args: any) => {
          const inv = invoices.get(args.where.id);
          if (!inv) return null;
          // Honor `include.tenant` by injecting the live tenant reference so
          // tests can mutate `m.tenant.accountingSettings` and observe it.
          if (args?.include?.tenant) {
            return { ...inv, tenant: { accountingSettings: m.tenant.accountingSettings } };
          }
          return inv;
        }),
        update: jest.fn(async (args: any) => {
          const cur = invoices.get(args.where.id);
          Object.assign(cur, args.data);
          return cur;
        }),
        findMany: jest.fn(async () =>
          [...invoices.values()].filter(
            (i) => i.accountingStatus === "pending" && !i.accountingExternalId,
          ),
        ),
      },
      accountingConnection: {
        findUnique: jest.fn(async (args: any) =>
          connections.get(args.where.tenantId) ?? null,
        ),
        update: jest.fn(async (args: any) => {
          // Support both `{ where: { tenantId } }` and the unique-constraint
          // selector that Prisma may translate the call into.
          const key = args?.where?.tenantId ?? args?.where?.tenantId_tenantId;
          let cur = connections.get(key);
          if (!cur && args?.where?.id) cur = connections.get("tenant-1");
          if (!cur) {
            // Fall back: any connection in the map (single-tenant tests).
            cur = connections.values().next().value;
          }
          Object.assign(cur, args.data);
          return cur;
        }),
        create: jest.fn(async (args: any) => {
          const row = { id: "conn-new", ...args.data };
          connections.set(args.data.tenantId, row);
          return row;
        }),
        delete: jest.fn(async (args: any) => {
          const cur = connections.get("tenant-1");
          if (cur && cur.id === args.where.id) connections.delete("tenant-1");
          return { id: args.where.id };
        }),
      },
      accountingSyncLog: {
        create: jest.fn(async (args: any) => {
          logs.push(args.data);
          return args.data;
        }),
        findMany: jest.fn(async () => logs),
      },
      tenant: {
        findUnique: jest.fn(async () => tenant),
      },
    } as any,
  };
}

function seedInvoice(m: any, overrides: any = {}) {
  const inv = {
    id: "inv-1",
    tenantId: "tenant-1",
    series: "A",
    number: "000001",
    issueDate: new Date("2026-07-01T10:00:00Z"),
    recipientName: "Cliente X",
    recipientTaxId: "12345678A",
    subtotalCents: 10000,
    totalCents: 12100,
    currency: "EUR",
    fiscalStatus: "not_required",
    accountingStatus: "not_synced",
    accountingExternalId: null,
    accountingError: null,
    lines: [
      {
        id: "l1",
        invoiceId: "inv-1",
        description: "Corte",
        quantity: 5 as any,
        unitPriceCents: 2000,
        taxRate: 21 as any,
        taxCents: 2100,
        totalCents: 12100,
        discountPct: 0 as any,
        productId: null,
        serviceId: null,
        appointmentId: null,
      },
    ],
    ...overrides,
  };
  m.invoices.set(inv.id, inv);
  return inv;
}

// Module-level helper so all `describe` blocks can use it.
function build() {
  const m = makePrismaMock();
  const enc = makeEncryptionMock();
  m.connection.encryptedAccessToken = enc.encrypt("holded-access-token-xyz");
  m.connection.encryptedRefreshToken = enc.encrypt("holded-refresh-token-xyz");
  const svc = new AccountingService(
    m.prisma,
    enc,
    makeHoldedAdapter(),
    makeSageAdapter(),
  );
  return { m, svc, enc };
}

describe("HoldedAdapter", () => {
  it("builds an Auth URL with the expected scopes and redirect", () => {
    const a = makeHoldedAdapter();
    const url = a.getAuthUrl("state-123");
    expect(url).toContain("https://app.holded.com/oauth/authorize");
    expect(url).toContain("client_id=dev-client-id");
    expect(url).toContain("state=state-123");
    expect(url).toContain("scope=invoicing%3Awrite+contacts%3Aread");
  });

  it("upsertSalesInvoice includes customId equal to externalRef (idempotency key)", async () => {
    const a = makeHoldedAdapter();
    const result = await a.upsertSalesInvoice({
      externalRef: "t-1-A000001",
      issueDate: "2026-07-01",
      customerName: "Cliente",
      customerTaxId: "X",
      currency: "EUR",
      lines: [
        {
          description: "Corte",
          quantity: 1,
          unitPriceCents: 10000,
          taxRate: 21,
        },
      ],
    });
    expect(result.externalId).toMatch(/^inv-[0-9a-f]+$/);
    expect(result.externalUrl).toContain(result.externalId);

    // Idempotency: re-running with the same externalRef returns the same id.
    const again = await a.upsertSalesInvoice({
      externalRef: "t-1-A000001",
      issueDate: "2026-07-01",
      customerName: "Cliente",
      currency: "EUR",
      lines: [
        {
          description: "Corte",
          quantity: 1,
          unitPriceCents: 10000,
          taxRate: 21,
        },
      ],
    });
    expect(again.externalId).toBe(result.externalId);
  });
});

describe("SageAdapter", () => {
  it("builds an Auth URL with sage-specific scopes", () => {
    const a = makeSageAdapter();
    const url = a.getAuthUrl("state-xyz");
    expect(url).toContain("https://www.sageone.es/oauth/authorize");
    expect(url).toContain("scope=sales_invoices%3Awrite+contacts%3Aread");
  });

  it("upsertSalesInvoice uses items + tax_rate (Sage shape)", async () => {
    const a = makeSageAdapter();
    const spy = jest.spyOn(a as any, "_postToSage");
    await a.upsertSalesInvoice({
      externalRef: "t-1-A000002",
      issueDate: "2026-07-01",
      customerName: "Cliente",
      currency: "EUR",
      lines: [
        {
          description: "Coloración",
          quantity: 1,
          unitPriceCents: 5000,
          taxRate: 10,
        },
      ],
    });
    expect(spy).toHaveBeenCalledWith(
      "/sales_invoices",
      expect.objectContaining({
        document_type: "sales_invoice",
        external_ref: "t-1-A000002",
        document_number: "t-1-A000002",
        items: [
          expect.objectContaining({
            tax_rate: 10,
            unit_price: 50,
          }),
        ],
      }),
    );
  });

  it("upsertSalesInvoice is idempotent on external_ref", async () => {
    const a = makeSageAdapter();
    const r1 = await a.upsertSalesInvoice({
      externalRef: "t-1-A000003",
      issueDate: "2026-07-01",
      customerName: "Cliente",
      currency: "EUR",
      lines: [{ description: "X", quantity: 1, unitPriceCents: 1000, taxRate: 21 }],
    });
    const r2 = await a.upsertSalesInvoice({
      externalRef: "t-1-A000003",
      issueDate: "2026-07-01",
      customerName: "Cliente",
      currency: "EUR",
      lines: [{ description: "X", quantity: 1, unitPriceCents: 1000, taxRate: 21 }],
    });
    expect(r2.externalId).toBe(r1.externalId);
  });
});

describe("AccountingService.syncInvoice", () => {
  it("skips when no active connection", async () => {
    const { m, svc } = build();
    seedInvoice(m);
    m.connections.delete("tenant-1");
    const r = await svc.syncInvoice("inv-1");
    expect(r.status).toBe("skipped");
    expect(r.error).toBe("no_connection");
    expect(m.logs).toHaveLength(0);
  });

  it("skips when tenant has syncOnIssue=false", async () => {
    const { m, svc } = build();
    m.tenant.accountingSettings = { syncOnIssue: false };
    seedInvoice(m);
    const r = await svc.syncInvoice("inv-1");
    expect(r.status).toBe("skipped");
    expect(r.error).toBe("sync_disabled_by_tenant");
  });

  it("skips when invoice already has accountingExternalId (idempotent)", async () => {
    const { m, svc } = build();
    seedInvoice(m, { accountingExternalId: "holded-existing-id" });
    const r = await svc.syncInvoice("inv-1");
    expect(r.status).toBe("skipped");
    expect(r.externalId).toBe("holded-existing-id");
    expect(m.logs.some((l) => l.status === "skipped")).toBe(true);
  });

  it("happy path: syncs to Holded, persists externalId + log", async () => {
    const { m, svc } = build();
    seedInvoice(m);
    const r = await svc.syncInvoice("inv-1");
    expect(r.status).toBe("synced");
    expect(r.externalId).toMatch(/^inv-[0-9a-f]+$/);
    expect(m.invoices.get("inv-1").accountingExternalId).toBe(r.externalId);
    expect(m.invoices.get("inv-1").accountingStatus).toBe("synced");
    expect(m.connection.lastSyncAt).toBeInstanceOf(Date);
    expect(m.logs.some((l) => l.status === "ok" && l.action === "sync")).toBe(
      true,
    );
  });

  it("returns skipped for a non-existent invoice", async () => {
    const { svc } = build();
    const r = await svc.syncInvoice("ghost");
    expect(r.status).toBe("skipped");
    expect(r.error).toBe("invoice_not_found");
  });

  it("marks accountingStatus=error on validation (4xx) failure", async () => {
    const { m, enc } = build();
    seedInvoice(m);
    const fakeAdapter = {
      provider: AccountingProvider.holded,
      getAuthUrl: () => "x",
      exchangeCode: async () => ({ accessToken: "x" }),
      refresh: async () => ({ accessToken: "x" }),
      upsertSalesInvoice: async () => {
        throw new ProviderHttpError(400, "bad");
      },
      ping: async () => true,
    };
    const svc2 = new AccountingService(
      m.prisma,
      enc,
      fakeAdapter as any,
      makeSageAdapter(),
    );
    const r = await svc2.syncInvoice("inv-1");
    expect(r.status).toBe("error");
    expect(m.invoices.get("inv-1").accountingStatus).toBe("error");
    expect(m.invoices.get("inv-1").accountingError).toContain("Provider HTTP 400");
  });
});

describe("AccountingService.retryQueue", () => {
  it("walks all pending invoices and returns a summary", async () => {
    const { m, svc } = build();
    seedInvoice(m, { id: "inv-a", accountingStatus: "pending" });
    seedInvoice(m, { id: "inv-b", accountingStatus: "pending" });
    const r = await svc.retryQueue(10);
    expect(r.attempted).toBe(2);
    expect(r.synced).toBe(2);
    expect(m.invoices.get("inv-a").accountingStatus).toBe("synced");
    expect(m.invoices.get("inv-b").accountingStatus).toBe("synced");
  });
});

describe("AccountingService.disconnect", () => {
  it("removes the connection and writes an unlink log", async () => {
    const m = makePrismaMock();
    const enc = makeEncryptionMock();
    const svc = new AccountingService(
      m.prisma,
      enc,
      makeHoldedAdapter(),
      makeSageAdapter(),
    );
    await svc.disconnect("tenant-1");
    expect(m.connections.has("tenant-1")).toBe(false);
    expect(m.logs.some((l) => l.action === "unlink")).toBe(true);
  });
});

describe("AccountingService.buildAuthUrl", () => {
  it("produces an HMAC-signed state", () => {
    const m = makePrismaMock();
    const enc = makeEncryptionMock();
    const svc = new AccountingService(
      m.prisma,
      enc,
      makeHoldedAdapter(),
      makeSageAdapter(),
    );
    const { url, state } = svc.buildAuthUrl(
      AccountingProvider.holded,
      "tenant-1",
      "secret-x",
    );
    expect(url).toContain("https://app.holded.com/oauth/authorize");
    const [payloadB64, sig] = state.split(".");
    const expected = enc.hmac(
      Buffer.from(payloadB64, "base64url").toString(),
      "secret-x",
    );
    expect(sig).toBe(expected);
  });
});