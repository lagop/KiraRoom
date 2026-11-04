/**
 * Audit 8 part B: managing salons from the SaaS console (T4, T5, T7, T9,
 * T13, T14, T17, T21, T22, T24, and the owner's decisions D3, D4, D6, D7).
 * In-memory Prisma mocks, no third-party calls.
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
const ACTOR = { id: "saas-1", role: "saas_owner" };
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
    blockedAt: null,
    blockedReason: null,
    courtesyUntil: null,
    courtesyPlan: null,
    courtesyWarnedAt: null,
    taxId: null,
    ...over,
  } as any;
}

function makeService(row: any, opts: { stripeFails?: boolean } = {}) {
  const tenants = new Map<string, any>([[row.id, row]]);
  const audit: any[] = [];
  const stripe = { calls: 0, paused: [] as boolean[] };
  const emails: any[] = [];
  const redirects: any[] = [];
  const userUpdates: any[] = [];
  const prisma: any = {
    tenant: {
      findFirst: async ({ where }: any) => {
        const t = tenants.get(where.id);
        return t && (where.deletedAt === null ? !t.deletedAt : true) ? t : null;
      },
      findUnique: async ({ where }: any) =>
        where.id ? (tenants.get(where.id) ?? null) : ([...tenants.values()].find((t) => t.slug === where.slug) ?? null),
      update: async ({ where, data }: any) => Object.assign(tenants.get(where.id), data),
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [],
      count: async () => 0,
    },
    tenantSlugRedirect: {
      findFirst: async ({ where }: any) => redirects.find((r) => r.oldSlug === where.oldSlug) ?? null,
      deleteMany: async () => ({ count: 0 }),
      create: async ({ data }: any) => {
        redirects.push(data);
        return data;
      },
    },
    user: {
      updateMany: async (args: any) => {
        userUpdates.push(args);
        return { count: 2 };
      },
      findFirst: async () => ({ email: "duena@example.com" }),
    },
    widgetInstance: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    $transaction: async (fn: any) => fn(prisma),
  };
  const subscriptions: any = {
    cancelStripeSubscriptionNow: async () => {
      stripe.calls += 1;
      if (opts.stripeFails) throw new ServiceUnavailableException("No se ha podido cancelar el cobro en Stripe.");
      return { cancelled: true };
    },
    setStripeCollectionPaused: async (_id: string, paused: boolean) => {
      stripe.paused.push(paused);
      if (opts.stripeFails) throw new ServiceUnavailableException("No se ha podido pausar el cobro en Stripe.");
      return { changed: true };
    },
  };
  const email: any = {
    sendAccountReadOnly: async (d: any) => {
      emails.push(d);
      return { success: true };
    },
  };
  const auditLog: any = { record: async (action: string, params: any) => { audit.push({ action, ...params }); return { id: `a-${audit.length}` }; } };
  const real = new SaasService(prisma, null as any, auditLog, subscriptions, undefined, email, undefined);
  // The console actor (#276) defaults to one platform owner in these tests.
  const svc: any = Object.create(real);
  svc.updateTenant = (id: string, dto: any, actor: any = ACTOR) => real.updateTenant(id, dto, actor);
  svc.suspendTenant = (id: string, actor: any = ACTOR) => real.suspendTenant(id, actor);
  svc.courtesyTenant = (id: string, input: any, actor: any = ACTOR) => real.courtesyTenant(id, input, actor);
  svc.blockTenant = (id: string, reason: string, actor: any = ACTOR) => real.blockTenant(id, reason, actor);
  svc.unblockTenant = (id: string, actor: any = ACTOR) => real.unblockTenant(id, actor);
  return { svc, tenants, audit, stripe, prisma, emails, redirects, userUpdates };
}

describe("T4: Cortesía clears the old retention state", () => {
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
  const until = () => new Date(Date.now() + 30 * DAY);

  it("reproduces the bug: with those dates, a later suspension is anonymised at once", () => {
    const step = retentionStep({ id: "t-1", name: "S", ...stale } as any, NOW);
    expect(step?.kind).toBe("anonymize");
  });

  it("after Cortesía and Suspender the next run does nothing", async () => {
    const { svc, tenants } = makeService(tenantRow(stale));
    await svc.courtesyTenant("t-1", { plan: "pro", until: until() });
    const t = tenants.get("t-1");
    expect(t).toMatchObject({ subscriptionStatus: "active", readOnlyUntil: null, cancelledAt: null, anonymizationWarnedAt: null, anonymizationWarnedFor: null });
    await svc.suspendTenant("t-1");
    expect(retentionStep(t, NOW)).toBeNull();
  });

  it("Suspender on a salon with stale dates (reactivated before this fix) resets them too", async () => {
    const { svc, tenants } = makeService(tenantRow({ ...stale, subscriptionStatus: "active" }));
    await svc.suspendTenant("t-1");
    expect(retentionStep(tenants.get("t-1"), NOW)).toBeNull();
    expect(tenants.get("t-1").anonymizationWarnedFor).toBeNull();
  });

  it("an edit can no longer leave read-only: that is Cortesía", async () => {
    const { svc, tenants } = makeService(tenantRow(stale));
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "active" as any })).rejects.toThrow(/Cortesía/);
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "trialing" as any, trialEnd: until() })).rejects.toThrow(/Cortesía/);
    expect(tenants.get("t-1").subscriptionStatus).toBe("cancelled");
  });

  it("refuses to drop a pending 'Borrar mi salón' silently", async () => {
    const requested = new Date("2026-10-20T09:00:00Z");
    const { svc, tenants } = makeService(tenantRow({ ...stale, deletionRequestedAt: requested, deletionRestore: { status: "active" } }));
    await expect(svc.courtesyTenant("t-1", { plan: "pro", until: until() })).rejects.toThrow(ConflictException);
    await expect(svc.courtesyTenant("t-1", { plan: "pro", until: until() })).rejects.toThrow(/pidió borrar este salón/);
    expect(tenants.get("t-1").subscriptionStatus).toBe("cancelled");
    expect(tenants.get("t-1").deletionRequestedAt).toBe(requested);
  });

  it("with the explicit checkbox it cancels the deletion too, on the one courtesy audit row", async () => {
    const { svc, tenants, audit } = makeService(tenantRow({ ...stale, deletionRequestedAt: new Date("2026-10-20T09:00:00Z") }));
    await svc.courtesyTenant("t-1", { plan: "pro", until: until(), cancelDeletion: true }, { id: "saas-2" });
    expect(tenants.get("t-1").deletionRequestedAt).toBeNull();
    expect(tenants.get("t-1").deletionRestore).toBe(Prisma.DbNull);
    expect(audit.map((x) => x.action)).toEqual(["tenant.courtesy"]);
    expect(audit[0].actorId).toBe("saas-2");
    expect(audit[0].metadata.deletionCancelled).toEqual({ requestedAt: "2026-10-20T09:00:00.000Z" });
  });
});

describe("D6: Cortesía", () => {
  it("stores the plan and the end date, active until then, on a tenant.courtesy row", async () => {
    const end = new Date(Date.now() + 20 * DAY);
    const { svc, tenants, audit } = makeService(tenantRow({ subscriptionStatus: "cancelled", readOnlyUntil: new Date(), stripeSubscriptionId: "sub_old" }));
    await svc.courtesyTenant("t-1", { plan: "empresa", until: end });
    expect(tenants.get("t-1")).toMatchObject({
      subscriptionStatus: "active",
      plan: "empresa",
      courtesyPlan: "empresa",
      courtesyUntil: end,
      currentPeriodEnd: end,
      courtesyWarnedAt: null,
      // The old, ended Stripe subscription no longer counts it as paying.
      stripeSubscriptionId: null,
    });
    expect(audit[0]).toMatchObject({ action: "tenant.courtesy", metadata: { subscriptionStatus: { before: "cancelled", after: "active" } } });
    expect(audit[0].metadata.courtesy).toMatchObject({ plan: "empresa", until: end.toISOString() });
  });

  it("needs a future end date, at most a year away", async () => {
    const { svc } = makeService(tenantRow({ subscriptionStatus: "cancelled" }));
    await expect(svc.courtesyTenant("t-1", { plan: "pro", until: new Date(Date.now() - DAY) })).rejects.toThrow(/posterior a hoy/);
    await expect(svc.courtesyTenant("t-1", { plan: "pro", until: new Date(Date.now() + 400 * DAY) })).rejects.toThrow(/como mucho/);
  });

  it("is refused for a salon that pays in Stripe and for a blocked one", async () => {
    const paying = makeService(tenantRow({ stripeSubscriptionId: "sub_1" }));
    await expect(paying.svc.courtesyTenant("t-1", { plan: "pro", until: new Date(Date.now() + DAY * 5) })).rejects.toThrow(/paga en Stripe/);
    const blocked = makeService(tenantRow({ subscriptionStatus: "cancelled", blockedAt: new Date() }));
    await expect(blocked.svc.courtesyTenant("t-1", { plan: "pro", until: new Date(Date.now() + DAY * 5) })).rejects.toThrow(/bloqueado/);
  });

  it("an edit cannot make a salon active without Stripe", async () => {
    const { svc } = makeService(tenantRow({ subscriptionStatus: "trialing", trialEnd: new Date(Date.now() + DAY) }));
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "active" as any })).rejects.toThrow(/Cortesía/);
  });

  it("a plan change during a courtesy moves the courtesy plan too", async () => {
    const { svc, tenants } = makeService(tenantRow({ courtesyUntil: new Date(Date.now() + 9 * DAY), courtesyPlan: "pro" }));
    await svc.updateTenant("t-1", { plan: "empresa" as any });
    expect(tenants.get("t-1")).toMatchObject({ plan: "empresa", courtesyPlan: "empresa" });
  });
});

describe("D4: Suspender ends the subscription", () => {
  it("cancels Stripe, sets cancelledAt and 30 days read-only, and emails the owner in Spanish", async () => {
    const { svc, tenants, audit, stripe, emails } = makeService(tenantRow({ stripeSubscriptionId: "sub_1", courtesyUntil: new Date() }));
    const before = Date.now();
    await svc.suspendTenant("t-1");
    const t = tenants.get("t-1");
    expect(stripe.calls).toBe(1);
    expect(t.subscriptionStatus).toBe("cancelled");
    expect(t.cancelledAt).toBeInstanceOf(Date);
    expect(t.readOnlyUntil.getTime() - before).toBeGreaterThanOrEqual(30 * DAY - 1000);
    expect(t.courtesyUntil).toBeNull();
    expect(audit.map((x) => x.action)).toEqual(["tenant.suspend"]);
    expect(audit[0].metadata).toMatchObject({ subscriptionStatus: { before: "active", after: "cancelled" }, stripeCancelled: true });
    expect(emails).toEqual([expect.objectContaining({ to: "duena@example.com", reason: "platform_cancelled", readOnlyUntil: t.readOnlyUntil })]);
  });

  it("changes nothing when Stripe fails", async () => {
    const { svc, tenants, audit, emails } = makeService(tenantRow({ stripeSubscriptionId: "sub_1" }), { stripeFails: true });
    await expect(svc.suspendTenant("t-1")).rejects.toThrow(ServiceUnavailableException);
    expect(tenants.get("t-1").subscriptionStatus).toBe("active");
    expect(audit).toEqual([]);
    expect(emails).toEqual([]);
  });

  it("an edit to De baja is refused: that is Suspender", async () => {
    const { svc } = makeService(tenantRow());
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "cancelled" as any })).rejects.toThrow(/Suspender/);
  });

  it("refuses a salon already read-only", async () => {
    const { svc } = makeService(tenantRow({ subscriptionStatus: "cancelled" }));
    await expect(svc.suspendTenant("t-1")).rejects.toThrow(/ya está de baja/);
  });
});

describe("D4: Bloquear and Desbloquear", () => {
  it("blocks at once: sessions end, Stripe collection paused, the status stays, on a tenant.block row", async () => {
    const { svc, tenants, audit, stripe, userUpdates, emails } = makeService(tenantRow({ stripeSubscriptionId: "sub_1" }));
    await svc.blockTenant("t-1", "  Spam a clientas  ");
    const t = tenants.get("t-1");
    expect(t.blockedAt).toBeInstanceOf(Date);
    expect(t.blockedReason).toBe("Spam a clientas");
    expect(t.subscriptionStatus).toBe("active");
    expect(stripe.paused).toEqual([true]);
    expect(userUpdates[0]).toMatchObject({ where: { tenantId: "t-1" }, data: { tokenVersion: { increment: 1 } } });
    expect(audit.map((x) => x.action)).toEqual(["tenant.block"]);
    expect(audit[0].metadata).toMatchObject({ reason: "Spam a clientas", stripeCollectionPaused: true });
    expect(emails).toEqual([]);
  });

  it("does not block when Stripe cannot pause the collection", async () => {
    const { svc, tenants, audit } = makeService(tenantRow({ stripeSubscriptionId: "sub_1" }), { stripeFails: true });
    await expect(svc.blockTenant("t-1", "x")).rejects.toThrow(ServiceUnavailableException);
    expect(tenants.get("t-1").blockedAt).toBeNull();
    expect(audit).toEqual([]);
  });

  it("unblocks: Stripe resumes and a tenant.unblock row is written", async () => {
    const { svc, tenants, audit, stripe } = makeService(tenantRow({ blockedAt: new Date("2026-11-01T00:00:00Z"), blockedReason: "x" }));
    await svc.unblockTenant("t-1");
    expect(tenants.get("t-1")).toMatchObject({ blockedAt: null, blockedReason: null });
    expect(stripe.paused).toEqual([false]);
    expect(audit[0]).toMatchObject({ action: "tenant.unblock", metadata: { blockedAt: "2026-11-01T00:00:00.000Z" } });
  });

  it("refuses to block twice, to unblock one not blocked, and to suspend a blocked one", async () => {
    const blocked = makeService(tenantRow({ blockedAt: new Date() }));
    await expect(blocked.svc.blockTenant("t-1", "x")).rejects.toThrow(/ya está bloqueado/);
    await expect(blocked.svc.suspendTenant("t-1")).rejects.toThrow(/bloqueado/);
    const free = makeService(tenantRow());
    await expect(free.svc.unblockTenant("t-1")).rejects.toThrow(/no está bloqueado/);
  });
});

describe("T21 / D7: the console's address change", () => {
  it("goes through tenant_slug_redirects and its own audit row, leaving the owner's once-only change", async () => {
    const { svc, tenants, audit, redirects } = makeService(tenantRow({ slugChangedAt: null }));
    await svc.updateTenant("t-1", { slug: "Salon-Lucia-Centro" } as any);
    expect(tenants.get("t-1").slug).toBe("salon-lucia-centro");
    expect(tenants.get("t-1").slugChangedAt).toBeNull();
    expect(redirects).toEqual([expect.objectContaining({ oldSlug: "salon-lucia", tenantId: "t-1" })]);
    expect(audit.map((x) => x.action)).toEqual(["tenant.web_address_changed"]);
    expect(audit[0].metadata).toMatchObject({ from: "salon-lucia", to: "salon-lucia-centro", source: "saas/console", platformAddress: false });
  });

  it("refuses an address still redirecting to another salon", async () => {
    const { svc, redirects } = makeService(tenantRow());
    redirects.push({ oldSlug: "salon-ana", tenantId: "t-2", expiresAt: new Date(Date.now() + DAY) });
    await expect(svc.updateTenant("t-1", { slug: "salon-ana" } as any)).rejects.toThrow(ConflictException);
  });

  it("a platform word needs the «Dirección de la plataforma» checkbox, and is on the audit row", async () => {
    const { svc, tenants, audit } = makeService(tenantRow());
    await expect(svc.updateTenant("t-1", { slug: "kiraroom-demo" } as any)).rejects.toThrow(/Dirección de la plataforma/);
    await svc.updateTenant("t-1", { slug: "kiraroom-demo", platformAddress: true } as any);
    expect(tenants.get("t-1").slug).toBe("kiraroom-demo");
    expect(audit[0].metadata.platformAddress).toBe(true);
  });

  it("technical reserved names stay refused even with the checkbox; brand ones are allowed with it", () => {
    expect(consoleSlugProblem("api", { platformAddress: true })).toBe("reserved");
    expect(consoleSlugProblem("www", { platformAddress: true })).toBe("reserved");
    expect(consoleSlugProblem("soporte")).toBe("reserved");
    expect(consoleSlugProblem("soporte", { platformAddress: true })).toBeNull();
    expect(consoleSlugProblem("kiraroom-demo")).toBe("platform_word");
    expect(consoleSlugProblem("kiraroom-demo", { platformAddress: true })).toBeNull();
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
    const { svc, tenants } = makeService(tenantRow({ subscriptionStatus: "trialing", trialEnd: past }));
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "trialing" as any })).rejects.toThrow(/ya ha terminado/);
    await expect(svc.updateTenant("t-1", { subscriptionStatus: "trialing" as any, trialEnd: past })).rejects.toThrow(/posterior a hoy/);
    const future = new Date(Date.now() + 7 * DAY);
    await svc.updateTenant("t-1", { subscriptionStatus: "trialing" as any, trialEnd: future });
    expect(tenants.get("t-1")).toMatchObject({ subscriptionStatus: "trialing", trialEnd: future, currentPeriodEnd: future });
  });

  it("refuses a plan change on a salon that pays in Stripe", async () => {
    const { svc } = makeService(tenantRow({ stripeSubscriptionId: "sub_1" }));
    await expect(svc.updateTenant("t-1", { plan: "empresa" as any })).rejects.toThrow(/en Stripe/);
    // The same plan, sent back by the form, is fine.
    await expect(svc.updateTenant("t-1", { plan: "pro" as any, name: "Otro" })).resolves.toBeDefined();
  });

  it("never stores platformAddress", async () => {
    const { svc, tenants } = makeService(tenantRow());
    await svc.updateTenant("t-1", { name: "Nuevo", platformAddress: true } as any);
    expect(tenants.get("t-1")).not.toHaveProperty("platformAddress");
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
  function makeGdpr(row: any, opts: { stripeFails?: boolean; platform?: boolean } = {}) {
    const calls: string[] = [];
    const prisma: any = { tenant: { findUnique: async () => row, count: async () => (opts.platform ? 1 : 0) } };
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

  it("refuses the Platform tenant (#276 guard) before anything else", async () => {
    const { svc, calls } = makeGdpr(tenantRow({ subscriptionStatus: "cancelled" }), { platform: true });
    await expect(svc.anonymize("t-1", "saas-1", undefined, { confirmName: "Salón Lucía" })).rejects.toThrow(/Platform/);
    expect(calls).toEqual([]);
  });

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
    expect(calls).toEqual(["stripe", "record", "anonymize:true", "tenant.anonymize"]);
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
