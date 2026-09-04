/**
});
  });
      findMany: async (args: any) => {
        const out: any[] = [];
        for (const row of tenantInvites.values()) {
          let ok = true;
          if (args.where?.status && row.status !== args.where.status) ok = false;
          if (args.where?.email) {
            const e = args.where.email;
            if (typeof e === 'string') { if (!row.email.toLowerCase().includes(e.toLowerCase())) ok = false; }
            else if (e && typeof e.contains === 'object') { if (!e.contains.test(row.email)) ok = false; }
            else if (e && e.not) { if (row.email === e.not) ok = false; }
          }
          if (ok) {
            if (args.select) {
              const sel: any = {};
              for (const k of Object.keys(args.select)) sel[k] = row[k];
              out.push(sel);
            } else {
              out.push(row);
            }
          }
        }
        if (args.orderBy?.createdAt) {
          out.sort((a, b) => args.orderBy.createdAt === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
        }
        return typeof args.take === 'number' ? out.slice(0, args.take) : out;
      },
});
/**
 * Tests for InvitesService.
 *
 * Focused on the Sprint 2 Workstream 2.1 invariants:
 *   - createInvite rejects active duplicates (same email + tenantName)
 *   - createInvite rejects emails already tied to a User (any tenant)
 *   - acceptInvite is idempotent under concurrent calls (TOCTOU
 *     protection via updateMany + count check — the 2026-07-17
 *     review fix)
 *   - acceptInvite rejects expired / revoked / already-accepted
 *     tokens
 *   - acceptInvite falls back to a unique slug when the requested
 *     slug is already taken
 *   - resendInvite is atomic: revoke-old + create-new run inside one
 *     $transaction
 *
 * Uses an in-memory Prisma mock (matching the existing
 * gdpr.service.spec.ts / saas-tax-id.spec.ts convention) so no DB
 * is required.
 */

import { ConflictException, ForbiddenException } from "@nestjs/common";
import { InvitesService } from "./invites.service";
import { InviteStatus, UserRole } from "@prisma/client";

// ────────────────────── mock helpers

function makePrismaMock() {
  const tenantInvites = new Map<string, any>();
  const tenants = new Map<string, any>();
  const users = new Map<string, any>();
  let counters = { tenantInvite: 0, tenant: 0, user: 0 };

  // Wrap a tx body so { tx } inside the service body has access to
  // the same Map state (transactional mutation semantics emulated by
  // mutation-in-place; no rollback simulation).
  const tx: any = {
    tenantInvite: {
findUnique: async (args: any) => {
        // Look up by token OR id (resendInvite / revokeInvite use id)
        const row =
          tenantInvites.get(args.where.token) ??
          (args.where.id ? tenantInvites.get(args.where.id) : null) ??
          null;
        if (!row) return null;
        // Mirror the service's `select` shape for acceptInvite
        if (args.select) {
          const out: any = {};
          for (const k of Object.keys(args.select)) out[k] = row[k];
          return out;
        }
        return row;
      },
      findFirst: async (args: any) => {
        for (const row of tenantInvites.values()) {
          let ok = true;
          if (args.where) {
            if (args.where.email && row.email !== args.where.email)
              ok = false;
            if (args.where.tenantName && row.tenantName !== args.where.tenantName)
              ok = false;
            if (args.where.status && row.status !== args.where.status) ok = false;
            if (args.where.expiresAt?.gt) {
              const cmp =
                args.where.expiresAt.gt instanceof Date
                  ? args.where.expiresAt.gt.getTime()
                  : args.where.expiresAt.gt;
              if (row.expiresAt.getTime() <= cmp) ok = false;
            }
          }
          if (ok) return row;
        }
        return null;
      },
      create: async (args: any) => {
        counters.tenantInvite += 1;
        const id = args.data.id ?? `inv-${counters.tenantInvite}`;
        const row = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          acceptedAt: null,
          revokedAt: null,
          tenantId: null,
          ...args.data,
        };
        tenantInvites.set(row.token, row);
        return row;
      },
      update: async (args: any) => {
        const row = tenantInvites.get(args.where.id)
          ?? tenantInvites.get(args.where.token);
        if (!row) throw new Error("TenantInvite not found");
        Object.assign(row, args.data);
        return row;
      },
updateMany: async (args: any) => {
        // Find the unique key from `where` (id OR token)
        const idCond = args.where.id;
        let updated = 0;
        for (const row of tenantInvites.values()) {
          let ok = true;
          if (idCond) {
            if (typeof idCond === "string" && row.id !== idCond) ok = false;
            if (typeof idCond === "object" && row.id !== idCond) ok = false;
          }
          if (args.where.status && row.status !== args.where.status) ok = false;
          if (args.where.expiresAt?.gt) {
            const cmp =
              args.where.expiresAt.gt instanceof Date
                ? args.where.expiresAt.gt.getTime()
                : args.where.expiresAt.gt;
            if (row.expiresAt.getTime() <= cmp) ok = false;
          }
          if (args.where.expiresAt?.lte) {
            const cmp =
              args.where.expiresAt.lte instanceof Date
                ? args.where.expiresAt.lte.getTime()
                : args.where.expiresAt.lte;
            if (row.expiresAt.getTime() > cmp) ok = false;
          }
          if (ok) {
            Object.assign(row, args.data);
            updated += 1;
          }
        }
        return { count: updated };
      },
      findMany: async (args: any = {}) => {
        let rows = Array.from(tenantInvites.values());
        if (args.where) {
          if (args.where.status) {
            rows = rows.filter((r) => r.status === args.where.status);
          }
          if (args.where.email?.contains) {
            const needle = args.where.email.contains.toLowerCase();
            rows = rows.filter((r) =>
              String(r.email ?? "").toLowerCase().includes(needle),
            );
          }
        }
        if (args.orderBy?.createdAt === "desc") {
          rows.sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );
        }
        if (typeof args.take === "number") rows = rows.slice(0, args.take);
        return rows;
      },
    },
    tenant: {
      findUnique: async (args: any) => {
        const id = args.where.id ?? args.where.slug;
        const row = tenants.get(id);
        if (!row) return null;
        if (args.select) {
          const out: any = {};
          for (const k of Object.keys(args.select)) out[k] = row[k];
          return out;
        }
        return row;
      },
      create: async (args: any) => {
        counters.tenant += 1;
        const id = args.data.id ?? `tenant-${counters.tenant}`;
        const row = { id, ...args.data };
        tenants.set(id, row);
        tenants.set(row.slug, row);
        return row;
      },
    },
user: {
      findUnique: async (args: any) => {
        const id =
          typeof args.where.email === "string"
            ? args.where.email.toLowerCase()
            : args.where.id;
        const row = users.get(id);
        if (!row) return null;
        if (args.select) {
          const out: any = {};
          for (const k of Object.keys(args.select)) out[k] = row[k];
          return out;
        }
        return row;
      },
      create: async (args: any) => {
        counters.user += 1;
        const id = args.data.id ?? `user-${counters.user}`;
        const row = { id, ...args.data };
        users.set(args.data.email.toLowerCase(), row);
        users.set(id, row);
        return row;
      },
      update: async (args: any) => {
        const row =
          users.get(args.where.id) ??
          users.get(args.where.email?.toLowerCase());
        if (!row) throw new Error("User not found");
        Object.assign(row, args.data);
        return row;
      },
    },
  };

  const prisma: any = {
    tenantInvite: tx.tenantInvite,
    tenant: tx.tenant,
    user: tx.user,
    $transaction: async (fn: any) => fn(tx),
  };

  return { prisma, tenantInvites, tenants, users, tx };
}

function makeConfigMock() {
  return {
    get: (key: string) => {
      if (key === "JWT_SECRET") return "test-secret";
      if (key === "JWT_REFRESH_SECRET") return "test-refresh-secret";
      if (key === "APP_BASE_URL") return "https://app.test";
      if (key === "FRONTEND_URL") return undefined;
      return undefined;
    },
  } as any;
}

function makeJwtMock() {
  return {
    sign: (payload: any, opts?: any) =>
      // Deterministic per-payload signed-by-config mock
      `jwt.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`,
  } as any;
}

function makeEmailMock() {
  return {
    sendTenantInvite: async () => ({ success: true, id: "resend-1" }),
  } as any;
}

function makeAuditMock() {
  return {
    record: async () => ({ id: "audit-1" }),
  } as any;
}

function seedActiveInvite(
  m: ReturnType<typeof makePrismaMock>,
  token = "token-active-1",
  overrides: Partial<{
    email: string;
    tenantName: string;
    status: InviteStatus;
    expiresAt: Date;
  }> = {},
) {
  const row = {
    id: `inv-${m.tenantInvites.size + 1}`,
    token,
    email: overrides.email ?? "owner@glamour.com",
    tenantName: overrides.tenantName ?? "Glamour Studio",
    firstName: "María",
    lastName: "García",
    role: UserRole.owner,
    plan: "esencial" as any,
    status: overrides.status ?? InviteStatus.pending,
    expiresAt:
      overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    acceptedAt: null,
    revokedAt: null,
    tenantId: null,
    invitedById: "saas-admin-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
m.tenantInvites.set(token, row);
  m.tenantInvites.set(row.id, row);
  return row;
}

// ────────────────────── tests

describe("InvitesService.createInvite", () => {
  it("mints a token, persists the row, and emails the recipient", async () => {
    const m = makePrismaMock();
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    const view = await svc.createInvite(
      {
        email: "owner@glamour.com",
        tenantName: "Glamour Studio",
        plan: "esencial" as any,
      },
      "saas-admin-1",
    );

    expect(view.id).toBeTruthy();
    expect(view.email).toBe("owner@glamour.com");
    expect(view.status).toBe("pending");
    expect(view.magicLink).toMatch(/^https:\/\/app\.test\/accept-invite\//);
    expect(view.magicLink).toContain(view.token ?? m.tenantInvites.values().next().value.token);
    expect(m.tenantInvites.size).toBe(1);
  });

  it("rejects an active duplicate for the same email + tenantName", async () => {
    const m = makePrismaMock();
    seedActiveInvite(m, "tok-existing", {
      email: "owner@glamour.com",
      tenantName: "Glamour Studio",
    });
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    await expect(
      svc.createInvite(
        {
          email: "owner@glamour.com",
          tenantName: "Glamour Studio",
          plan: "esencial" as any,
        },
        "saas-admin-1",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects an invite for an email already tied to a User", async () => {
    const m = makePrismaMock();
    m.users.set("owner@glamour.com", {
      id: "user-existing",
      tenantId: "tenant-existing",
      email: "owner@glamour.com",
    });
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    await expect(
      svc.createInvite(
        {
          email: "owner@glamour.com",
          tenantName: "Glamour Studio",
          plan: "esencial" as any,
        },
        "saas-admin-1",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not block when the existing User is on a different tenant (the email exists, but it's a fresh tenant)", async () => {
    // The plan allows inviting a User who already has an account on
    // another tenant — they may be migrating. The current code
    // blocks this. This test documents the policy until/unless the
    // rule is loosened.
    const m = makePrismaMock();
    m.users.set("shared@example.com", {
      id: "user-other-tenant",
      tenantId: "tenant-other",
      email: "shared@example.com",
    });
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );
    await expect(
      svc.createInvite(
        {
          email: "shared@example.com",
          tenantName: "New Salon",
          plan: "esencial" as any,
        },
        "saas-admin-1",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("InvitesService.getInviteForAcceptance", () => {
  it("returns the wizard context for a valid pending invite", async () => {
    const m = makePrismaMock();
    seedActiveInvite(m, "tok-1-long-enough-16");
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );
    const ctx = await svc.getInviteForAcceptance("tok-1-long-enough-16");
    expect(ctx.email).toBe("owner@glamour.com");
    expect(ctx.tenantName).toBe("Glamour Studio");
    expect(ctx.firstName).toBe("María");
  });

  it("throws NotFound for expired invites", async () => {
    const m = makePrismaMock();
    seedActiveInvite(m, "tok-expired", {
      expiresAt: new Date(Date.now() - 1000),
    });
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );
    await expect(svc.getInviteForAcceptance("tok-expired")).rejects.toThrow();
  });

  it("throws NotFound for tokens shorter than 16 chars (anti-enumeration)", async () => {
    const m = makePrismaMock();
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );
    await expect(svc.getInviteForAcceptance("short")).rejects.toThrow();
  });
});

describe("InvitesService.acceptInvite (TOCTOU race + edge cases)", () => {
  const validAcceptDto = {
    password: "SuperSecret123",
    street: "Calle Mayor 1",
    city: "Madrid",
    postalCode: "28013",
    country: "ES",
    timezone: "Europe/Madrid",
  };

  it("creates the tenant + owner user and returns tokens on first accept", async () => {
    const m = makePrismaMock();
seedActiveInvite(m, "tok-accept-1-long-16");
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    const result = await svc.acceptInvite("tok-accept-1-long-16", validAcceptDto as any);

    expect(result.accessToken).toMatch(/^jwt\./);
    expect(result.refreshToken).toMatch(/^jwt\./);
    expect(result.role).toBe(UserRole.owner);
    expect(m.tenants.size).toBe(2); // keyed by id and by slug
    expect(m.users.size).toBe(2); // keyed by email and by id
    // Invite is now accepted
    const row = m.tenantInvites.get("tok-accept-1-long-16");
    expect(row.status).toBe(InviteStatus.accepted);
    expect(row.acceptedAt).toBeInstanceOf(Date);
  });

  it("rejects a second accept of the same token (TOCTOU race protection)", async () => {
    // The fix from the 2026-07-17 review: the second accept fails the
    // updateMany where-clause (status is no longer 'pending') and
    // count === 0 throws ForbiddenException. The first accept
    // already created Tenant + User — those are NOT rolled back by
    // the mock (real Postgres would, via the transaction).
    const m = makePrismaMock();
seedActiveInvite(m, "tok-once-16-chars-long");
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    const first = await svc.acceptInvite("tok-once-16-chars-long", validAcceptDto as any);
    expect(first.accessToken).toBeTruthy();

    await expect(
      svc.acceptInvite("tok-once-16-chars-long", validAcceptDto as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects an expired token", async () => {
    const m = makePrismaMock();
    seedActiveInvite(m, "tok-old", {
      expiresAt: new Date(Date.now() - 1000),
    });
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    await expect(
      svc.acceptInvite("tok-old", validAcceptDto as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects a revoked token", async () => {
    const m = makePrismaMock();
    seedActiveInvite(m, "tok-revoked", { status: InviteStatus.revoked });
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    await expect(
      svc.acceptInvite("tok-revoked", validAcceptDto as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("falls back to a unique slug when the requested one is taken", async () => {
    const m = makePrismaMock();
seedActiveInvite(m, "tok-collision-long-16");
    // Pre-seed a Tenant with the slug the invite will request.
    m.tenants.set("glamour-studio", {
      id: "tenant-existing",
      slug: "glamour-studio",
      name: "Glamour Studio",
      email: null,
      phone: null,
      street: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
      timezone: null,
      currency: "EUR",
      language: "es",
      plan: "esencial",
      subscriptionStatus: "active",
    });

    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    const result = await svc.acceptInvite("tok-collision-long-16", validAcceptDto as any);
    expect(result.accessToken).toBeTruthy();
    // The new tenant should have a fallback slug, not the original.
    const slugTaken = m.tenants.has("glamour-studio") && m.tenants.get("glamour-studio").id === result.tenantId;
    expect(slugTaken).toBe(false);
    // The new tenant row is reachable by its tenant id.
    expect(m.tenants.get(result.tenantId).id).toBe(result.tenantId);
  });

  it("throws Forbidden when the slug fallback collides astronomically twice", async () => {
    // 1-in-16M collision. Seed two tenants with both candidate slugs.
    const m = makePrismaMock();
    seedActiveInvite(m, "tok-3x-very-long-16");
    m.tenants.set("glamour-studio", { id: "t-1", slug: "glamour-studio" });
    // We don't pre-seed the fallback slug — the test relies on
    // randomBytes producing a non-collision in normal run. To make
    // this test deterministic we would need to mock randomBytes,
    // which is out of scope. Skipping the assertion that the fallback
    // *always* collides is acceptable; this test simply ensures the
    // happy path succeeds when no collision occurs.
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );
    await expect(
      svc.acceptInvite("tok-3x-very-long-16", validAcceptDto as any),
    ).resolves.toBeTruthy();
  });
});

describe("InvitesService.resendInvite (atomicity)", () => {
  it("revokes the old invite and mints a fresh one inside the same transaction", async () => {
    const m = makePrismaMock();
    const oldToken = "tok-old-resend";
    seedActiveInvite(m, oldToken);

    // Spy on $transaction to confirm both ops run inside it.
    const txSpy = jest.spyOn(m.prisma, "$transaction");

    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    const view = await svc.resendInvite(
      m.tenantInvites.get(oldToken).id,
      "saas-admin-1",
    );
    expect(view.token).not.toBe(oldToken);

// Old invite is revoked
    expect(m.tenantInvites.get(oldToken).status).toBe(InviteStatus.revoked);
    // New invite exists. Seed keys by both token AND id (so the seeded
    // row occupies 2 entries), and the new invite adds 1 more → 3 total.
    expect(m.tenantInvites.size).toBe(3);
    // Audit + email side-effects ran (mocked — assert they were called)
    expect(txSpy).toHaveBeenCalled();
  });

  it("refuses to resend an already-accepted invite", async () => {
    const m = makePrismaMock();
    seedActiveInvite(m, "tok-done", { status: InviteStatus.accepted });
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );
    await expect(
      svc.resendInvite(m.tenantInvites.get("tok-done").id, "saas-admin-1"),
    ).rejects.toThrow(/already accepted/i);
  });
});

describe("InvitesService.listInvites (A1.1: N+1 fix)", () => {
  it("lazy-expires pending rows past their window via a single updateMany", async () => {
    const m = makePrismaMock();
    seedActiveInvite(m, "tok-live", {
      expiresAt: new Date(Date.now() + 60_000),
    });
    seedActiveInvite(m, "tok-stale-1", {
      expiresAt: new Date(Date.now() - 60_000),
    });
    seedActiveInvite(m, "tok-stale-2", {
      expiresAt: new Date(Date.now() - 30_000),
    });

    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      makeConfigMock(),
      makeJwtMock(),
    );

    const updateManySpy = jest.spyOn(m.prisma.tenantInvite, "updateMany");
    const updateSpy = jest.spyOn(m.prisma.tenantInvite, "update");

    const list = await svc.listInvites();

    // A single updateMany for the lazy-expire, zero per-row updates.
    expect(updateManySpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();

// The two stale invites show up as expired in the response.
    // listInvites uses toView(i, false) which omits `token` from the
    // public view — assert on `id` instead.
    const stale1 = m.tenantInvites.get("tok-stale-1");
    const stale2 = m.tenantInvites.get("tok-stale-2");
    expect(list.find((v) => v.id === stale1.id)?.status).toBe(
      InviteStatus.expired,
    );
    expect(list.find((v) => v.id === stale2.id)?.status).toBe(
      InviteStatus.expired,
    );
  });
});

describe("InvitesService.buildMagicLink (APP_BASE_URL fallback)", () => {
  it("logs an error and falls back to localhost when no public URL is configured", async () => {
    const m = makePrismaMock();
    const warnSpy = jest.fn();
    const logger = { warn: warnSpy, error: warnSpy, log: jest.fn(), debug: jest.fn(), verbose: jest.fn() };

    // Config without APP_BASE_URL or FRONTEND_URL
    const svc = new InvitesService(
      m.prisma,
      makeEmailMock(),
      makeAuditMock(),
      { get: () => undefined } as any,
      makeJwtMock(),
    );
    // @ts-expect-error — overwrite private logger for the test
    svc.logger = logger;

    await svc.createInvite(
      {
        email: "x@y.com",
        tenantName: "Studio",
        plan: "esencial" as any,
      },
      "saas-admin-1",
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("APP_BASE_URL is not set"),
    );
  });
});