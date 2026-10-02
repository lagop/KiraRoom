/**
 * AccountingService: what happens to an invoice around the Holded push.
 *
 * Why these tests exist: the old service "synced" every invoice to a stub
 * that made ids up, so a salon was told its books were in Holded when
 * nothing had been sent. These pin the honest behaviour:
 *   - the key is checked against Holded before it is stored, and stored
 *     encrypted;
 *   - the id persisted is the one Holded returned;
 *   - failures are recorded on the invoice and in the log, transient ones are
 *     retried with backoff and eventually given up, permanent ones are not
 *     retried;
 *   - everything the panel can trigger is scoped to the caller's salon.
 * The adapter is mocked here; its HTTP contract is in holded.adapter.spec.
 */

import { AccountingProvider } from "@prisma/client";
import { AccountingService, MAX_AUTO_ATTEMPTS } from "./accounting.service";
import { HoldedApiError, HoldedSetupError } from "./providers/holded.adapter";
import { EncryptionService } from "../common/encryption/encryption.service";

function makeEncryption(): EncryptionService {
  return new EncryptionService({
    get: (key: string) =>
      key === "META_TOKEN_ENCRYPTION_KEY" ? Buffer.alloc(32, 7).toString("base64") : null,
  } as any);
}

function setup(opts: { connected?: boolean; syncOnIssue?: boolean } = {}) {
  const enc = makeEncryption();
  const invoices = new Map<string, any>();
  const connections = new Map<string, any>();
  const logs: any[] = [];
  const tenantSettings: Record<string, any> = {
    "tenant-1": { syncOnIssue: opts.syncOnIssue ?? true },
  };
  if (opts.connected !== false) {
    connections.set("tenant-1", {
      id: "conn-1",
      tenantId: "tenant-1",
      provider: AccountingProvider.holded,
      encryptedAccessToken: enc.encrypt("salon-holded-key"),
      isActive: true,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      lastError: null,
    });
  }

  const prisma: any = {
    invoice: {
      findFirst: jest.fn(async ({ where }: any) => {
        const inv = invoices.get(where.id);
        if (!inv || (where.tenantId && inv.tenantId !== where.tenantId)) return null;
        return {
          ...inv,
          tenant: { accountingSettings: tenantSettings[inv.tenantId], fiscalSettings: { taxRegime: "iva" } },
        };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(invoices.get(where.id), data)),
      findMany: jest.fn(async ({ where }: any) =>
        [...invoices.values()].filter(
          (i) =>
            (!where.accountingStatus || i.accountingStatus === where.accountingStatus) &&
            (!where.tenantId || i.tenantId === where.tenantId) &&
            !i.accountingExternalId,
        ),
      ),
      count: jest.fn(async () => 0),
      groupBy: jest.fn(async () => []),
    },
    accountingConnection: {
      findUnique: jest.fn(async ({ where }: any) => connections.get(where.tenantId) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const c = [...connections.values()].find((x) => x.id === where.id);
        return Object.assign(c, data);
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = connections.get(where.tenantId);
        const row = existing
          ? Object.assign(existing, update)
          : { id: "conn-new", createdAt: new Date(), ...create };
        connections.set(where.tenantId, row);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        for (const [k, v] of connections) if (v.id === where.id) connections.delete(k);
      }),
    },
    accountingSyncLog: {
      create: jest.fn(async ({ data }: any) => {
        logs.push({ createdAt: new Date(), ...data });
      }),
      findMany: jest.fn(async ({ where }: any) =>
        logs
          .filter(
            (l) =>
              l.invoiceId === where.invoiceId &&
              l.status === where.status &&
              l.createdAt >= where.createdAt.gte,
          )
          .sort((a, b) => b.createdAt - a.createdAt),
      ),
    },
    tenant: {
      findUnique: jest.fn(async () => ({ accountingSettings: tenantSettings["tenant-1"] })),
      update: jest.fn(async ({ data }: any) => {
        tenantSettings["tenant-1"] = data.accountingSettings;
      }),
    },
  };

  const holded = {
    verifyKey: jest.fn(async () => undefined),
    pushInvoice: jest.fn(async () => ({ externalId: "65f0aa", alreadyInHolded: false })),
  };
  const svc = new AccountingService(prisma, enc, holded as any);

  const seed = (overrides: any = {}) => {
    const inv = {
      id: "inv-1",
      tenantId: "tenant-1",
      series: "A",
      number: "000007",
      issueDate: new Date("2026-09-15T10:00:00Z"),
      recipientName: "Lucía Ejemplo",
      recipientTaxId: "12345678Z",
      totalCents: 4235,
      currency: "EUR",
      status: "issued",
      notes: null,
      accountingStatus: "not_synced",
      accountingExternalId: null,
      accountingError: null,
      lines: [
        { description: "Corte", quantity: "1", unitPriceCents: 3500, discountPct: "0", taxRate: "21" },
      ],
      ...overrides,
    };
    invoices.set(inv.id, inv);
    return inv;
  };

  return { svc, prisma, holded, enc, invoices, connections, logs, seed, tenantSettings };
}

describe("AccountingService.connectHolded", () => {
  it("verifies the key with Holded and stores it encrypted", async () => {
    const t = setup({ connected: false });
    await t.svc.connectHolded("tenant-1", "  pasted-key-1234  ");
    expect(t.holded.verifyKey).toHaveBeenCalledWith("pasted-key-1234");
    const conn = t.connections.get("tenant-1");
    expect(conn.provider).toBe("holded");
    expect(conn.encryptedAccessToken).not.toContain("pasted-key");
    expect(t.enc.decrypt(conn.encryptedAccessToken)).toBe("pasted-key-1234");
  });

  it("does not store a key Holded rejects", async () => {
    const t = setup({ connected: false });
    t.holded.verifyKey.mockRejectedValueOnce(new HoldedApiError(401, "Invalid API key"));
    await expect(t.svc.connectHolded("tenant-1", "wrong-key-123")).rejects.toThrow(/no reconoce esta clave/);
    expect(t.connections.size).toBe(0);
  });

  it("names the missing permissions on a 403", async () => {
    const t = setup({ connected: false });
    t.holded.verifyKey.mockRejectedValueOnce(new HoldedApiError(403, "Forbidden"));
    await expect(t.svc.connectHolded("tenant-1", "scoped-key-123")).rejects.toThrow(/faltan permisos/);
  });
});

describe("AccountingService.syncInvoice", () => {
  it("stores the id Holded returned and logs it", async () => {
    const t = setup();
    t.seed();
    const r = await t.svc.syncInvoice("inv-1");
    expect(r).toEqual({ status: "synced", externalId: "65f0aa" });
    const inv = t.invoices.get("inv-1");
    expect(inv.accountingExternalId).toBe("65f0aa");
    expect(inv.accountingStatus).toBe("synced");
    const [key, input, opts] = t.holded.pushInvoice.mock.calls[0] as any[];
    expect(key).toBe("salon-holded-key");
    expect(input).toMatchObject({
      documentNumber: "A000007",
      issueDate: "2026-09-15",
      customerTaxId: "12345678Z",
      regime: "iva",
      lines: [{ description: "Corte", quantity: 1, unitPriceCents: 3500, discountPct: 0, taxRate: 21 }],
    });
    expect(opts).toEqual({ checkExisting: false });
    expect(t.logs.at(-1)).toMatchObject({ status: "ok", externalId: "65f0aa", invoiceId: "inv-1" });
  });

  it("skips without calling Holded when the salon has no connection", async () => {
    const t = setup({ connected: false });
    t.seed();
    expect(await t.svc.syncInvoice("inv-1")).toMatchObject({ status: "skipped", error: "no_connection" });
    expect(t.holded.pushInvoice).not.toHaveBeenCalled();
    expect(t.invoices.get("inv-1").accountingStatus).toBe("not_synced");
  });

  it("respects syncOnIssue=false on issue, but a manual send still goes", async () => {
    const t = setup({ syncOnIssue: false });
    t.seed();
    expect(await t.svc.syncInvoice("inv-1")).toMatchObject({ status: "skipped" });
    expect(t.holded.pushInvoice).not.toHaveBeenCalled();
    expect(await t.svc.syncInvoice("inv-1", { trigger: "manual", tenantId: "tenant-1" })).toMatchObject({
      status: "synced",
    });
  });

  it("never syncs another salon's invoice from the panel", async () => {
    const t = setup();
    t.seed();
    expect(await t.svc.syncInvoice("inv-1", { trigger: "manual", tenantId: "tenant-2" })).toMatchObject({
      status: "skipped",
      error: "invoice_not_found",
    });
    expect(t.holded.pushInvoice).not.toHaveBeenCalled();
  });

  it("does not send drafts or cancelled invoices", async () => {
    const t = setup();
    t.seed({ status: "cancelled" });
    expect(await t.svc.syncInvoice("inv-1")).toMatchObject({ status: "skipped", error: "not_issued" });
  });

  it("leaves a transient failure pending, to be retried", async () => {
    const t = setup();
    t.seed();
    t.holded.pushInvoice.mockRejectedValueOnce(new HoldedApiError(503, "Service Unavailable"));
    const r = await t.svc.syncInvoice("inv-1");
    expect(r.status).toBe("pending");
    expect(t.invoices.get("inv-1").accountingStatus).toBe("pending");
    expect(t.invoices.get("inv-1").accountingExternalId).toBeNull();
    expect(t.logs.at(-1)).toMatchObject({ status: "error", payload: { retry: true, httpStatus: 503 } });
  });

  it("marks a validation error as error with Holded's message, no retry", async () => {
    const t = setup();
    t.seed();
    t.holded.pushInvoice.mockRejectedValueOnce(new HoldedApiError(422, "contact_id is invalid"));
    const r = await t.svc.syncInvoice("inv-1");
    expect(r.status).toBe("error");
    expect(t.invoices.get("inv-1").accountingError).toContain("contact_id is invalid");
    expect(t.logs.at(-1).payload).toMatchObject({ retry: false, httpStatus: 422 });
  });

  it("records a revoked key on the connection so the panel can ask to reconnect", async () => {
    const t = setup();
    t.seed();
    t.holded.pushInvoice.mockRejectedValueOnce(new HoldedApiError(401, "Invalid API key"));
    await t.svc.syncInvoice("inv-1");
    expect(t.invoices.get("inv-1").accountingStatus).toBe("error");
    expect(t.connections.get("tenant-1").lastError).toMatch(/Vuelve a conectar Holded/);
  });

  it("explains a missing tax as an error the salon must fix", async () => {
    const t = setup();
    t.seed();
    t.holded.pushInvoice.mockRejectedValueOnce(new HoldedSetupError("Tu cuenta de Holded no tiene un impuesto…"));
    expect((await t.svc.syncInvoice("inv-1")).status).toBe("error");
  });

  it("does not send rectificativas as ordinary invoices", async () => {
    const t = setup();
    t.seed({ series: "R", totalCents: -1210 });
    expect((await t.svc.syncInvoice("inv-1")).status).toBe("error");
    expect(t.holded.pushInvoice).not.toHaveBeenCalled();
    expect(t.invoices.get("inv-1").accountingError).toMatch(/rectificativas/);
  });

  it("asks the adapter to look for a duplicate when an earlier attempt failed", async () => {
    const t = setup();
    t.seed({ accountingStatus: "pending" });
    await t.svc.syncInvoice("inv-1", { trigger: "retry" });
    expect((t.holded.pushInvoice.mock.calls[0] as any[])[2]).toEqual({ checkExisting: true });
  });

  it("is a no-op for an invoice already in Holded", async () => {
    const t = setup();
    t.seed({ accountingExternalId: "65f0aa", accountingStatus: "synced" });
    expect(await t.svc.syncInvoice("inv-1")).toEqual({ status: "skipped", externalId: "65f0aa" });
    expect(t.holded.pushInvoice).not.toHaveBeenCalled();
  });
});

describe("AccountingService.retryDue", () => {
  const now = new Date("2026-09-20T12:00:00Z");

  it("waits out the backoff after a failure", async () => {
    const t = setup();
    t.seed({ accountingStatus: "pending" });
    t.logs.push({ invoiceId: "inv-1", action: "sync", status: "error", createdAt: new Date(now.getTime() - 60_000) });
    const r = await t.svc.retryDue(now);
    expect(r).toMatchObject({ retried: 0, notDue: 1 });
    expect(t.holded.pushInvoice).not.toHaveBeenCalled();
  });

  it("retries once the backoff has passed", async () => {
    const t = setup();
    t.seed({ accountingStatus: "pending" });
    t.logs.push({ invoiceId: "inv-1", action: "sync", status: "error", createdAt: new Date(now.getTime() - 11 * 60_000) });
    const r = await t.svc.retryDue(now);
    expect(r).toMatchObject({ retried: 1, synced: 1 });
    expect(t.invoices.get("inv-1").accountingExternalId).toBe("65f0aa");
  });

  it(`gives up into 'error' after ${MAX_AUTO_ATTEMPTS} failures`, async () => {
    const t = setup();
    t.seed({ accountingStatus: "pending" });
    for (let i = 0; i < MAX_AUTO_ATTEMPTS; i++) {
      t.logs.push({ invoiceId: "inv-1", action: "sync", status: "error", createdAt: new Date(now.getTime() - (i + 1) * 3600_000) });
    }
    const r = await t.svc.retryDue(now);
    expect(r.gaveUp).toBe(1);
    expect(t.invoices.get("inv-1").accountingStatus).toBe("error");
    expect(t.holded.pushInvoice).not.toHaveBeenCalled();
  });

  it("only picks invoices of salons still connected", async () => {
    const t = setup();
    await t.svc.retryDue(now);
    const where = (t.prisma.invoice.findMany.mock.calls[0] as any[])[0].where;
    expect(where.tenant).toEqual({
      accountingConnection: { is: { isActive: true, provider: "holded" } },
    });
  });
});

describe("AccountingService.pushPending", () => {
  it("refuses without a Holded connection", async () => {
    const t = setup({ connected: false });
    await expect(t.svc.pushPending("tenant-1")).rejects.toThrow(/Conecta Holded/);
  });

  it("sends the salon's unsynced invoices and reports the counts", async () => {
    const t = setup();
    t.seed({ accountingStatus: "error" });
    const r = await t.svc.pushPending("tenant-1", "2026-01-01");
    expect(r).toMatchObject({ attempted: 1, synced: 1, errors: 0 });
    const where = (t.prisma.invoice.findMany.mock.calls[0] as any[])[0].where;
    expect(where.tenantId).toBe("tenant-1");
    expect(where.issueDate).toEqual({ gte: new Date("2026-01-01T00:00:00.000Z") });
  });
});
