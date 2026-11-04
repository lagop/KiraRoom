/**
 * Audit 8 part B: managing salons from the SaaS console (T4, T5, T7, T9,
 * T13, T14, T17, T22, T24). In-memory Prisma mocks, no third-party calls.
 */
import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SaasService } from "./saas.service";
import { retentionStep } from "./retention/salon-retention";
import { CONSOLE_TENANT_SELECT, consoleSlugProblem, rethrowUniqueConflict, retentionView } from "./console-tenant";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { GdprConsoleService, sameSalonName } from "./gdpr/gdpr-console.service";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-04T10:00:00Z");

function tenantRow(over: Record<string, unknown> = {}) {
  return {
    id: "t-1",
    name: "Salón Lucía",
    slug: "salon-lucia",
    plan: "pro",
    subscriptionStatus: "active",
    stripeSubscriptionId: null,
    subscriptionCancelAt: null,
    trialEnd: null,
    currentPeriodEnd: null,
    readOnlyUntil: null,
    cancelledAt: null,
    anonymizationWarnedAt: null,
    anonymizationWarnedFor: null,
    anonymizedAt: null,
    deletionRequestedAt: null,
    deletionRestore: null,
    deletedAt: null,
    taxId: null,
    ...over,
  } as any;
}

function makeService(row: any, opts: { stripeFails?: boolean } = {}) {
  const tenants = new Map<string, any>([[row.id, row]]);
  const audit: any[] = [];
  const stripe = { calls: 0 };
  const prisma: any = {
    tenant: {
      findFirst: async ({ where }: any) => {
        const t = tenants.get(where.id);
        return t && (where.deletedAt === null ? !t.deletedAt : true) ? t : null;
      },
      findUnique: async ({ where }: any) => tenants.get(where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(tenants.get(where.id), data),
      findMany: async () => [],
      count: async () => 0,
    },
    user: { updateMany: async () => ({ count: 2 }) },
    widgetInstance: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    $transaction: async (fn: any) => fn(prisma),
  };
  const subscriptions: any = {
    cancelStripeSubscriptionNow: async () => {
      stripe.calls += 1;
      if (opts.stripeFails) throw new ServiceUnavailableException("No se ha podido cancelar el cobro en Stripe.");
      return { cancelled: true };
    },
  };
  const auditLog: any = { record: async (action: string, params: any) => { audit.push({ action, ...params }); return { id: `a-${audit.length}` }; } };
  const svc = new SaasService(prisma, null as any, auditLog, subscriptions);
  return { svc, tenants, audit, stripe, prisma };
}

describe("T4: Reactivar clears the old retention state", () => {
  // The case from the report: trial ended (read-only until 1 July), owner
  // warned, reactivated by hand, suspended months later.
  const readOnlyUntil = new Date("2026-07-01T00:00:00Z");
  const stale = {
    subscriptionStatus: "cancelled",
    readOnlyUntil,
    cancelledAt: new Date("2026-06-01T00:00:00Z"),
    anonymizationWarnedAt: new Date("2026-07-24T04:40:00Z"),
    anonymizationWarnedFor: readOnlyUntil,
  };

  it("reproduces the bug: with those dates, a later suspension is anonymised at once", () => {
    const step = retentionStep({ id: "t-1", name: "S", ...stale } as any, NOW);
    expect(step?.kind).toBe("anonymize");
  });

  it("after Reactivar and Suspender the next run does nothing", async () => {
    const { svc, tenants } = makeService(tenantRow(stale));
    await svc.reactivateTenant("t-1");
    const t = tenants.get("t-1");
    expect(t).toMatchObject({ subscriptionStatus: "active", readOnlyUntil: null, cancelledAt: null, anonymizationWarnedAt: null, anonymizationWarnedFor: null });
    await svc.suspendTenant("t-1");
    expect(retentionStep(t, NOW)).toBeNull();
  });

  it("Suspender on a salon with stale dates (reactivated before this fix) clears them too", async () => {
    const { svc, tenants } = makeService(tenantRow({ ...stale, subscriptionStatus: "active" }));
    await svc.suspendTenant("t-1");
    expect(retentionStep(tenants.get("t-1"), NOW)).toBeNull();
  });

  it("Editar to Activo clears them as well", async () => {
    const { svc, tenants } = makeService(tenantRow(stale));
    await svc.updateTenant("t-1", { subscriptionStatus: "active" as any });
    expect(tenants.get("t-1").readOnlyUntil).toBeNull();
    expect(tenants.get("t-1").anonymizationWarnedFor).toBeNull();
  });

  it("refuses to drop a pending 'Borrar mi salón' silently", async () => {
    const requested = new Date("2026-10-20T09:00:00Z");
    const { svc, tenants } = makeService(tenantRow({ ...stale, deletionRequestedAt: requested, deletionRestore: { status: "active" } }));
    await expect(svc.reactivateTenant("t-1")).rejects.toThrow(ConflictException);
    await expect(svc.reactivateTenant("t-1")).rejects.toThrow(/pidió borrar este salón/);
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "active" as any })).rejects.toThrow(ConflictException);
    expect(tenants.get("t-1").subscriptionStatus).toBe("cancelled");
    expect(tenants.get("t-1").deletionRequestedAt).toBe(requested);
  });

  it("with the explicit checkbox it cancels the deletion too, audit-logged", async () => {
    const { svc, tenants, audit } = makeService(tenantRow({ ...stale, deletionRequestedAt: new Date("2026-10-20T09:00:00Z") }));
    await svc.reactivateTenant("t-1", { cancelDeletion: true }, "saas-1");
    expect(tenants.get("t-1").deletionRequestedAt).toBeNull();
    expect(tenants.get("t-1").deletionRestore).toBe(Prisma.DbNull);
    expect(audit.map((a) => a.action)).toEqual(["tenant.deletion_cancelled"]);
    expect(audit[0].actorId).toBe("saas-1");
  });
});

describe("T13: plan and status edits stay consistent", () => {
  it("refuses statuses Stripe owns", async () => {
    const { svc } = makeService(tenantRow());
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "past_due" as any })).rejects.toThrow(/los pone Stripe/);
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "suspended" as any })).rejects.toThrow(BadRequestException);
  });

  it("refuses En prueba with a trial that has ended, unless a new end date extends it", async () => {
    const past = new Date(Date.now() - 2 * DAY);
    const { svc, tenants } = makeService(tenantRow({ subscriptionStatus: "cancelled", trialEnd: past }));
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "trialing" as any })).rejects.toThrow(/ya ha terminado/);
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "trialing" as any, trialEnd: past })).rejects.toThrow(/posterior a hoy/);
    const future = new Date(Date.now() + 7 * DAY);
    await svc.updateTenant("t-1", { subscriptionStatus: "trialing" as any, trialEnd: future });
    expect(tenants.get("t-1")).toMatchObject({ subscriptionStatus: "trialing", trialEnd: future, currentPeriodEnd: future, readOnlyUntil: null });
  });

  it("refuses a plan change on a salon that pays in Stripe", async () => {
    const { svc } = makeService(tenantRow({ stripeSubscriptionId: "sub_1" }));
    await expect(svc.updateTenant("t-1", { plan: "empresa" as any })).rejects.toThrow(/en Stripe/);
    // The same plan, sent back by the form, is fine.
    await expect(svc.updateTenant("t-1", { plan: "pro" as any, name: "Otro" })).resolves.toBeDefined();
  });

  it("refuses De baja while Stripe still charges it", async () => {
    const { svc } = makeService(tenantRow({ stripeSubscriptionId: "sub_1" }));
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "cancelled" as any })).rejects.toThrow(/no deja de cobrarle/);
  });

  it("never stores cancelDeletion", async () => {
    const { svc, tenants } = makeService(tenantRow());
    await svc.updateTenant("t-1", { name: "Nuevo", cancelDeletion: true } as any);
    expect(tenants.get("t-1")).not.toHaveProperty("cancelDeletion");
  });
});

describe("T14: delete does not go on when Stripe fails", () => {
  it("throws the Spanish 503 and deletes nothing", async () => {
    const { svc, tenants, audit } = makeService(tenantRow({ stripeSubscriptionId: "sub_1" }), { stripeFails: true });
    await expect(svc.deleteTenant("t-1", "saas-1")).rejects.toThrow(ServiceUnavailableException);
    expect(tenants.get("t-1").deletedAt).toBeNull();
    expect(audit).toEqual([]);
  });

  it("deletes once Stripe has ended the subscription", async () => {
    const { svc, tenants, stripe } = makeService(tenantRow({ stripeSubscriptionId: "sub_1" }));
    await svc.deleteTenant("t-1", "saas-1");
    expect(stripe.calls).toBe(1);
    expect(tenants.get("t-1").deletedAt).toBeInstanceOf(Date);
    expect(tenants.get("t-1").subscriptionStatus).toBe("cancelled");
  });
});

describe("T9 / T24: the detail page", () => {
  it("opens a deleted salon too, and the select has no secrets", async () => {
    const { svc, prisma } = makeService(tenantRow({ deletedAt: new Date() }));
    prisma.tenant.findUnique = async ({ where, select }: any) => {
      expect(select).toMatchObject({ id: true, deletedAt: true });
      return { ...tenantRow({ id: where.id, deletedAt: new Date(), stripeSubscriptionId: "sub_1" }), users: [], _count: { users: 1, clients: 2, appointments: 3, professionals: 1, services: 4, payments: 0 } };
    };
    const t: any = await svc.getTenantById("t-1");
    expect(t.deletedAt).toBeInstanceOf(Date);
    expect(t.hasStripeSubscription).toBe(true);
    expect(t).not.toHaveProperty("stripeSubscriptionId");
    expect(t.retention).toHaveProperty("anonymizeOn");
  });

  it("CONSOLE_TENANT_SELECT never reads secrets or internal settings", () => {
    for (const col of ["stripeTestSecretKey", "stripeLiveSecretKey", "features", "fiscalSettings", "accountingSettings", "deletionRestore"]) {
      expect(CONSOLE_TENANT_SELECT).not.toHaveProperty(col);
    }
  });

  it("retentionView says when it is anonymised and what the next run does", () => {
    const readOnlyUntil = new Date(NOW.getTime() - 26 * DAY);
    const v = retentionView({ id: "t", name: "S", subscriptionStatus: "cancelled", readOnlyUntil, anonymizationWarnedAt: null, anonymizationWarnedFor: null, anonymizedAt: null, deletionRequestedAt: null, deletedAt: null }, NOW);
    expect(v.anonymizeOn?.getTime()).toBe(readOnlyUntil.getTime() + 30 * DAY);
    expect(v.nextStep).toBe("warn");
  });
});

describe("T17: search by the owner's email", () => {
  it("adds the owner's email and name to the search", async () => {
    const { svc, prisma } = makeService(tenantRow());
    let where: any;
    prisma.tenant.findMany = async (args: any) => { where = args.where; return []; };
    await svc.getAllTenants({ search: "maria@gmail.com" } as any);
    expect(JSON.stringify(where.OR)).toContain('"users":{"some":{"role":"owner"');
  });
});

describe("T6 / T7 / T22: create and edit validation", () => {
  it("the salon email may be left empty; a bad one is refused in Spanish", async () => {
    const ok = plainToInstance(CreateTenantDto, { name: "Lucía", plan: "esencial", email: "" });
    expect(await validate(ok)).toEqual([]);
    const bad = plainToInstance(CreateTenantDto, { name: "Lucía", plan: "esencial", email: "nope" });
    const errors = await validate(bad);
    expect(Object.values(errors[0].constraints ?? {})[0]).toBe("El email del salón no es válido.");
  });

  it("the edit DTO turns dates into dates and has no isSuspended", async () => {
    const dto = plainToInstance(UpdateTenantDto, { trialEnd: "2026-11-30" });
    expect(await validate(dto)).toEqual([]);
    expect(dto.trialEnd).toBeInstanceOf(Date);
    const bad = plainToInstance(UpdateTenantDto, { trialEnd: "mañana" });
    expect(Object.values((await validate(bad))[0].constraints ?? {})[0]).toMatch(/fecha válida/);
    expect(Object.keys(new UpdateTenantDto())).not.toContain("isSuspended");
  });

  it("the address needs 3 characters and the right shape; reserved names stay refused", () => {
    expect(consoleSlugProblem("s")).toBe("too_short");
    expect(consoleSlugProblem("sal on")).toBe("format");
    expect(consoleSlugProblem("www")).toBe("reserved");
    expect(consoleSlugProblem("salon-lucia")).toBeNull();
  });

  it("createTenant refuses a one-letter address", async () => {
    const { svc } = makeService(tenantRow());
    await expect(svc.createTenant({ name: "Salón Lucía", slug: "s", plan: "esencial" } as any)).rejects.toThrow(/al menos 3/);
  });

  it("a duplicate unique column is a Spanish 409, not a 500", () => {
    const err = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x", meta: { target: ["slug"] } });
    expect(() => rethrowUniqueConflict(err)).toThrow(ConflictException);
    expect(() => rethrowUniqueConflict(err)).toThrow(/dirección web/);
    expect(() => rethrowUniqueConflict(new Error("other"))).toThrow("other");
  });
});

describe("T5: the console's GDPR erasure", () => {
  function makeGdpr(row: any, opts: { stripeFails?: boolean } = {}) {
    const calls: string[] = [];
    const prisma: any = { tenant: { findUnique: async () => row } };
    const gdpr: any = {
      recordRequest: async () => { calls.push("record"); return { id: "req-1" }; },
      anonymize: async (_t: string, _r: string, o: any) => { calls.push(`anonymize:${o.keepFiscalData}`); },
      failRequest: async () => { calls.push("failed"); },
    };
    const subs: any = {
      cancelStripeSubscriptionNow: async () => {
        calls.push("stripe");
        if (opts.stripeFails) throw new ServiceUnavailableException("Stripe");
        return { cancelled: true };
      },
    };
    const audit: any = { record: async (a: string) => { calls.push(a); return { id: "x" }; } };
    return { svc: new GdprConsoleService(prisma, gdpr, subs, audit), calls };
  }

  it("needs the salon's name typed", async () => {
    const { svc, calls } = makeGdpr(tenantRow({ subscriptionStatus: "cancelled" }));
    await expect(svc.anonymize("t-1", "saas-1", undefined, { confirmName: "Otro" })).rejects.toThrow(/no coincide/);
    expect(calls).toEqual([]);
    expect(sameSalonName("  salon   lucia ", "Salón Lucía")).toBe(true);
  });

  it("refuses an active salon unless forced", async () => {
    const { svc, calls } = makeGdpr(tenantRow({ subscriptionStatus: "active", stripeSubscriptionId: "sub_1" }));
    await expect(svc.anonymize("t-1", "saas-1", undefined, { confirmName: "Salón Lucía" })).rejects.toThrow(/sigue activo/);
    expect(calls).toEqual([]);
    await svc.anonymize("t-1", "saas-1", undefined, { confirmName: "Salón Lucía", force: true });
    expect(calls).toEqual(["stripe", "record", "anonymize:true", "tenant.gdpr_anonymize"]);
  });

  it("cancels Stripe first and anonymises nothing if that fails", async () => {
    const { svc, calls } = makeGdpr(tenantRow({ subscriptionStatus: "cancelled", stripeSubscriptionId: "sub_1" }), { stripeFails: true });
    await expect(svc.anonymize("t-1", "saas-1", undefined, { confirmName: "Salón Lucía" })).rejects.toThrow(ServiceUnavailableException);
    expect(calls).toEqual(["stripe"]);
  });

  it("a deleted salon needs no force", async () => {
    const { svc, calls } = makeGdpr(tenantRow({ subscriptionStatus: "active", deletedAt: new Date() }));
    await svc.anonymize("t-1", "saas-1", undefined, { confirmName: "salón lucía" });
    expect(calls).toContain("anonymize:true");
  });
});
