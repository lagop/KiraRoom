import { NotFoundException } from "@nestjs/common";
import { TENANT_INTERNAL_AUDIT_ACTION, TenantInternalController } from "./tenant-internal.controller";
import { COUNTABLE_TENANT_WHERE, countableTenantWhere } from "./saas.constants";

function setup(seed: { id: string; slug: string; isInternal: boolean } | null) {
  const tenants = new Map<string, any>();
  if (seed) tenants.set(seed.id, { ...seed });
  const records: any[] = [];
  const tenant = {
    findFirst: jest.fn(async (args: any) => {
      const t = tenants.get(args.where.id);
      return t && args.where.deletedAt === null ? { ...t } : null;
    }),
    update: jest.fn(async (args: any) => {
      const t = tenants.get(args.where.id);
      Object.assign(t, args.data);
      return { id: t.id, isInternal: t.isInternal };
    }),
  };
  const prisma: any = { tenant, $transaction: async (fn: any) => fn({ tenant }) };
  const auditLog: any = {
    record: jest.fn(async (action: string, params: any, tx: any) => {
      records.push({ action, ...params, inTx: !!tx });
      return { id: "a1" };
    }),
  };
  const controller = new TenantInternalController(prisma, auditLog);
  const req = { user: { id: "owner-1", role: "saas_owner" } };
  return { controller, tenants, records, tenant, req };
}

describe("TenantInternalController (audit 8 D11)", () => {
  it("marks a salon internal and records who did it", async () => {
    const s = setup({ id: "t1", slug: "zz-demo", isInternal: false });
    await expect(s.controller.setInternal(s.req, "t1", { isInternal: true })).resolves.toEqual({
      id: "t1",
      isInternal: true,
    });
    expect(s.tenants.get("t1").isInternal).toBe(true);
    expect(s.records).toEqual([
      {
        action: TENANT_INTERNAL_AUDIT_ACTION,
        actorId: "owner-1",
        actorRole: "saas_owner",
        tenantId: "t1",
        metadata: { slug: "zz-demo", from: false, to: true },
        inTx: true,
      },
    ]);
  });

  it("does nothing, and logs nothing, when the flag is already set", async () => {
    const s = setup({ id: "t1", slug: "salon", isInternal: false });
    await expect(s.controller.setInternal(s.req, "t1", { isInternal: false })).resolves.toEqual({
      id: "t1",
      isInternal: false,
    });
    expect(s.tenant.update).not.toHaveBeenCalled();
    expect(s.records).toHaveLength(0);
  });

  it("404s for a missing or deleted salon", async () => {
    const s = setup(null);
    await expect(s.controller.setInternal(s.req, "t9", { isInternal: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("countableTenantWhere", () => {
  it("leaves out deleted and internal salons, keeping the extra conditions", () => {
    expect(COUNTABLE_TENANT_WHERE).toEqual({ deletedAt: null, isInternal: false });
    expect(countableTenantWhere()).toEqual({ deletedAt: null, isInternal: false });
    expect(countableTenantWhere({ plan: "pro" })).toEqual({ plan: "pro", deletedAt: null, isInternal: false });
    // The flag cannot be overridden by the caller's conditions.
    expect(countableTenantWhere({ isInternal: true } as any)).toEqual({ deletedAt: null, isInternal: false });
  });
});
