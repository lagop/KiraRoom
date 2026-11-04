import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthService } from "../auth.service";
import { JwtStrategy } from "../strategies/jwt.strategy";
import { SaasService } from "../../saas/saas.service";
import { SaasOwnerTwoFactorGuard } from "../../common/guards/saas-owner-two-factor.guard";
import { AuthController } from "../auth.controller";
import { SaasController } from "../../saas/saas.controller";
import { SupportAccessService } from "./support-access.controller";
import { SUPPORT_ACCESS_OFF_CODE, supportSessionsFromAudit } from "./support-access";
import { saasOwnerTwoFactorRequired } from "../two-factor/saas-owner-two-factor";

const NOW_S = () => Math.floor(Date.now() / 1000);

/** Audit 8 D2: the owner's consent to support sessions, and the email she gets. */
describe("support access setting (D2)", () => {
  function redeem(allowSupportAccess: boolean) {
    const owner = { id: "owner-1", email: "o@salon.test", role: "owner", tenantId: "t1", isActive: true, tokenVersion: 0, professional: null };
    const tx: any = { usedImpersonationToken: { create: jest.fn() } };
    const prisma: any = {
      tenant: { findFirst: jest.fn(async () => ({ id: "t1", name: "Salón Lucía", timezone: "Europe/Madrid", allowSupportAccess })) },
      user: {
        findUnique: jest.fn(async () => ({ id: "saas-1", role: "saas_owner", isActive: true, tokenVersion: 2, firstName: "Ana", lastName: "Soporte" })),
        findFirst: jest.fn(async () => owner),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const payload = {
      sub: "saas-1",
      jti: "jti-1",
      tv: 2,
      aud: "impersonation",
      impersonate: { tenantId: "t1", ownerId: "owner-1", reason: "La agenda no carga" },
    };
    const jwt: any = { verify: jest.fn(() => payload), sign: jest.fn(() => "signed") };
    const audit: any = { record: jest.fn() };
    const email: any = { sendSupportSessionStarted: jest.fn(async () => ({ success: true })) };
    const sessions: any = { start: jest.fn(async () => ({ sid: "s", jti: "j" })) };
    const auth = new AuthService(prisma, jwt, audit, {} as any, email, sessions, {} as any);
    return { auth, email, tx, audit };
  }

  it("emails the owner in Spanish when a support session starts: who, when, why, and the setting", async () => {
    const { auth, email } = redeem(true);
    await auth.impersonate("tok", "impersonation");
    await new Promise((r) => setImmediate(r));
    expect(email.sendSupportSessionStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "o@salon.test",
        tenantName: "Salón Lucía",
        supportName: "Ana Soporte",
        reason: "La agenda no carga",
        settingsUrl: expect.stringMatching(/\/dashboard\/settings\/seguridad#soporte$/),
      }),
    );
  });

  it("refuses the redeem when the owner turned support access off, without burning the token", async () => {
    const { auth, email, tx } = redeem(false);
    const err = await auth.impersonate("tok", "impersonation").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: SUPPORT_ACCESS_OFF_CODE });
    expect(tx.usedImpersonationToken.create).not.toHaveBeenCalled();
    expect(email.sendSupportSessionStarted).not.toHaveBeenCalled();
  });

  it("the console cannot launch a session into a salon that said no", async () => {
    const prisma: any = {
      tenant: {
        findFirst: jest.fn(async () => ({ id: "t1", name: "Salón Lucía", allowSupportAccess: false })),
        count: jest.fn(async () => 0),
      },
      user: { findUnique: jest.fn(async () => ({ tokenVersion: 0 })), findFirst: jest.fn() },
    };
    const service = Object.create(SaasService.prototype);
    Object.assign(service, { prisma, jwtService: { sign: jest.fn() } });
    const err = await service.launchSalonDashboard("t1", "saas-1", "La agenda no carga").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: SUPPORT_ACCESS_OFF_CODE });
  });

  it("an open support session ends when the owner turns it off", async () => {
    const user = {
      id: "owner-1",
      role: "owner",
      tenantId: "t1",
      isActive: true,
      tokenVersion: 0,
      tenant: { plan: "pro", subscriptionStatus: "active", deletedAt: null, allowSupportAccess: false },
    };
    const strategy = new JwtStrategy(
      { get: () => "secret-of-sufficient-length-for-tests" } as any,
      {
        user: {
          findUnique: jest.fn(async (a: any) =>
            a.where.id === "owner-1" ? user : { role: "saas_owner", isActive: true, tokenVersion: 4 },
          ),
        },
      } as any,
    );
    const token = {
      sub: "owner-1",
      role: "owner",
      tenantId: "t1",
      tv: 0,
      typ: "access",
      impersonatedBy: "saas-1",
      impersonationId: "imp-1",
      impersonatedTenantId: "t1",
      impersonationEndsAt: NOW_S() + 600,
      impersonatorTv: 4,
    } as any;
    await expect(strategy.validate(token)).rejects.toBeInstanceOf(UnauthorizedException);
    // The owner's own session is not affected by her choice.
    const { impersonatedBy: _i, impersonationId: _d, impersonatedTenantId: _t, impersonationEndsAt: _e, impersonatorTv: _v, ...own } = token;
    await expect(strategy.validate(own)).resolves.toMatchObject({ id: "owner-1" });
  });

  it("lists recent support sessions with date, reason and duration", () => {
    const start = new Date("2026-11-04T10:00:00Z");
    const rows = [
      {
        id: "a1",
        createdAt: start,
        actorId: "saas-1",
        action: "saas.impersonate",
        metadata: { reason: "La agenda no carga", impersonationId: "i1", endsAt: "2026-11-04T12:00:00Z" },
      },
      { id: "a2", createdAt: new Date("2026-11-04T10:25:00Z"), actorId: "saas-1", action: "saas.impersonate.end", metadata: { impersonationId: "i1" } },
      {
        id: "a3",
        createdAt: new Date("2026-11-03T09:00:00Z"),
        actorId: "saas-1",
        action: "saas.impersonate",
        metadata: { reason: "Configurar servicios", impersonationId: "i2", endsAt: "2026-11-03T11:00:00Z" },
      },
      {
        id: "a4",
        createdAt: new Date("2026-11-04T11:00:00Z"),
        actorId: "saas-1",
        action: "saas.impersonate",
        metadata: { reason: "Revisar la web", impersonationId: "i3", endsAt: "2026-11-04T13:00:00Z" },
      },
    ];
    const sessions = supportSessionsFromAudit(rows, new Map([["saas-1", "Ana Soporte"]]), new Date("2026-11-04T11:30:00Z"));
    expect(sessions.map((s) => [s.id, s.status, s.durationSeconds, s.reason, s.supportName])).toEqual([
      ["i3", "active", null, "Revisar la web", "Ana Soporte"],
      ["i1", "ended", 1500, "La agenda no carga", "Ana Soporte"],
      ["i2", "expired", null, "Configurar servicios", "Ana Soporte"],
    ]);
  });

  it("the owner's change is saved and audited once", async () => {
    const tx: any = { tenant: { update: jest.fn() } };
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ allowSupportAccess: true })) },
      auditLog: { findMany: jest.fn(async () => []) },
      user: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const audit: any = { record: jest.fn() };
    await new SupportAccessService(prisma, audit).set("t1", { id: "owner-1", role: "owner" as any }, false);
    expect(tx.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { allowSupportAccess: false } });
    expect(audit.record).toHaveBeenCalledWith(
      "tenant.support_access.updated",
      expect.objectContaining({ tenantId: "t1", metadata: { allowed: false } }),
      tx,
    );
  });
});

/** Audit 8 D15: SAAS_OWNER_2FA_REQUIRED, off by default. */
describe("platform owner 2FA requirement (D15)", () => {
  const ctx = (user: any, handler: (...a: any[]) => any, cls: any) =>
    ({
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as any;
  const guard = (flag: string | undefined) =>
    new SaasOwnerTwoFactorGuard(new Reflector(), { get: (k: string) => (k === "SAAS_OWNER_2FA_REQUIRED" ? flag : undefined) } as any);
  const without2fa = { id: "saas-1", role: "saas_owner", twoFactorEnabled: false };
  const console = SaasController.prototype;
  const auth = AuthController.prototype;
  const anyConsoleRoute = Object.getOwnPropertyNames(console)
    .map((n) => Object.getOwnPropertyDescriptor(console, n)?.value)
    .find((h) => typeof h === "function" && h !== SaasController);

  it("is off unless the flag is exactly true", () => {
    expect(saasOwnerTwoFactorRequired(() => undefined)).toBe(false);
    expect(saasOwnerTwoFactorRequired(() => "false")).toBe(false);
    expect(saasOwnerTwoFactorRequired(() => "1")).toBe(false);
    expect(saasOwnerTwoFactorRequired(() => "true")).toBe(true);
  });

  it("flag off: the console works without 2FA", () => {
    expect(guard(undefined).canActivate(ctx(without2fa, anyConsoleRoute, SaasController))).toBe(true);
  });

  it("flag on: without 2FA only the setup routes answer", () => {
    const g = guard("true");
    expect(() => g.canActivate(ctx(without2fa, anyConsoleRoute, SaasController))).toThrow(ForbiddenException);
    for (const name of ["getProfile", "twoFactorStatus", "twoFactorSetup", "twoFactorEnable", "logout", "changeOwnPassword"]) {
      const handler = Object.getOwnPropertyDescriptor(auth, name)?.value;
      expect({ name, found: typeof handler === "function" }).toEqual({ name, found: true });
      expect(g.canActivate(ctx(without2fa, handler, AuthController))).toBe(true);
    }
  });

  it("flag on: with 2FA, or for anyone else, nothing changes", () => {
    const g = guard("true");
    expect(g.canActivate(ctx({ ...without2fa, twoFactorEnabled: true }, anyConsoleRoute, SaasController))).toBe(true);
    expect(g.canActivate(ctx({ id: "o", role: "owner" }, anyConsoleRoute, SaasController))).toBe(true);
    expect(g.canActivate(ctx(undefined, anyConsoleRoute, SaasController))).toBe(true);
  });
});
