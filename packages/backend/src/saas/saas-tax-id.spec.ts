/**
 * Tests for the SaaS-admin `PATCH /tenants/:id` endpoint's handling of
 * P2A tax identity fields (taxId, taxIdType, legalName).
 *
 * Verifies the controller + service correctly accepts valid NIFs, rejects
 * malformed ones with 400, and records taxId changes to the audit trail.
 */

import { SaasService } from "./saas.service";

function makePrismaMock(tenantSeed?: { id: string; taxId: string | null }) {
  const tenants = new Map<string, any>();
  if (tenantSeed) {
    tenants.set(tenantSeed.id, {
      id: tenantSeed.id,
      taxId: tenantSeed.taxId,
      name: "Salon Test",
      slug: "salon-test",
      status: "active",
      createdAt: new Date(),
    });
  }

  const prisma: any = {
    tenant: {
      findFirst: async (args: any) => tenants.get(args.where.id) ?? null,
      findUnique: async (args: any) => tenants.get(args.where.id) ?? null,
      update: async (args: any) => {
        const cur = tenants.get(args.where.id);
        if (!cur) throw new Error("not found");
        Object.assign(cur, args.data);
        return cur;
      },
    },
  };
  return { prisma, tenants };
}

const CIF_CONTROL_LETTERS = "JABCDEFGHI";
const CIF_LETTER_GROUP = new Set([
  "C", "D", "F", "G", "H", "J", "K", "N", "P", "Q", "R", "S", "U", "V", "W",
]);

function cifControl(letter: string, body: string): string {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const d = parseInt(body[i], 10);
    const w = i % 2 === 0 ? 2 : 1;
    const p = d * w;
    sum += p < 10 ? p : Math.floor(p / 10) + (p % 10);
  }
  const rounded = Math.ceil(sum / 10) * 10;
  const digit = (10 - (rounded % 10)) % 10;
  return CIF_LETTER_GROUP.has(letter) ? CIF_CONTROL_LETTERS[digit] : String(digit);
}

function makeCif(letter: string, body = "1234567"): string {
  return `${letter}${body}${cifControl(letter, body)}`;
}

class CapturingAuditLog {
  records: Array<{
    action: string;
    actorId: string;
    actorRole: string;
    tenantId?: string;
    metadata?: any;
  }> = [];
  async record(action: string, params: any) {
    this.records.push({ action, ...params });
    return { id: `audit-${this.records.length}` };
  }
}

function buildService(prisma: any, auditLog: CapturingAuditLog): SaasService {
  const svc = new SaasService(
    prisma,
    /* jwtService */ null as any,
    auditLog as any,
    /* subscriptions */ null as any,
  );
  (svc as any).__capturedWarns = [];
  return svc;
}

function svcCaptured(svc: SaasService): string[] {
  return (svc as any).__capturedWarns;
}

describe("SaasService.updateTenant — taxId fields (P2A)", () => {
  it("accepts a valid CIF and persists it normalized", async () => {
    const { prisma, tenants } = makePrismaMock({ id: "t-1", taxId: null });
    const audit = new CapturingAuditLog();
    const svc = buildService(prisma, audit);
    (svc as any).logger = { warn: (m: string) => svcCaptured(svc).push(m) };

    // A is in the {digit} group. Body 1234567 + digit control = A12345670.
    const cif = makeCif("A", "1234567");
    await svc.updateTenant("t-1", {
      taxId: cif,
      taxIdType: "cif" as any,
      legalName: "Acme S.L.",
    });
    const cur = tenants.get("t-1");
    expect(cur.taxId).toBe(cif);
    expect(cur.legalName).toBe("Acme S.L.");
    // First setting of taxId is itself a "change" — must be audited.
    expect(audit.records.length).toBe(1);
    expect(audit.records[0].action).toBe("tenant.taxId.change");
    expect(audit.records[0].tenantId).toBe("t-1");
    expect(audit.records[0].metadata).toEqual({
      before: null,
      after: cif,
    });
  });

  it("rejects a malformed taxId with a BadRequest-like error", async () => {
    const { prisma, tenants } = makePrismaMock({ id: "t-2", taxId: null });
    const audit = new CapturingAuditLog();
    const svc = buildService(prisma, audit);
    (svc as any).logger = { warn: (m: string) => svcCaptured(svc).push(m) };
    tenants.set("t-2", makeExistingTenant("t-2"));
    await expect(svc.updateTenant("t-2", { taxId: "999" })).rejects.toThrow(
      /taxId invalid/,
    );
    expect(audit.records.length).toBe(0);
  });

  it("leaves the tenant untouched when no taxId is supplied", async () => {
    const { prisma, tenants } = makePrismaMock({
      id: "t-3",
      taxId: "B12345670",
    });
    const audit = new CapturingAuditLog();
    const svc = buildService(prisma, audit);
    (svc as any).logger = { warn: (m: string) => svcCaptured(svc).push(m) };
    await svc.updateTenant("t-3", { legalName: "Renamed SA" });
    const cur = tenants.get("t-3");
    expect(cur.taxId).toBe("B12345670");
    expect(cur.legalName).toBe("Renamed SA");
    expect(audit.records.length).toBe(0);
  });

  it("records audit row when taxId changes", async () => {
    const { prisma, tenants } = makePrismaMock({
      id: "t-4",
      taxId: "OLD-NIF",
    });
    const audit = new CapturingAuditLog();
    const svc = buildService(prisma, audit);
    (svc as any).logger = { warn: (m: string) => svcCaptured(svc).push(m) };
    await svc.updateTenant("t-4", { taxId: "B12345670" });
    expect(audit.records.length).toBe(1);
    expect(audit.records[0].action).toBe("tenant.taxId.change");
    expect(audit.records[0].tenantId).toBe("t-4");
    expect(audit.records[0].metadata).toEqual({
      before: "OLD-NIF",
      after: "B12345670",
    });
  });

  it("does not record when taxId equals the existing value", async () => {
    const { prisma, tenants } = makePrismaMock({
      id: "t-5",
      taxId: "B12345670",
    });
    const audit = new CapturingAuditLog();
    const svc = buildService(prisma, audit);
    (svc as any).logger = { warn: (m: string) => svcCaptured(svc).push(m) };
    await svc.updateTenant("t-5", { taxId: "B12345670" });
    expect(audit.records.length).toBe(0);
  });
});

function makeExistingTenant(id: string, taxId: string | null = null) {
  return {
    id,
    taxId,
    name: "Salon Test",
    slug: "salon-test",
    status: "active",
    createdAt: new Date(),
  };
}
