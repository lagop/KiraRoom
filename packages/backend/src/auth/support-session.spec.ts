import { UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";

/**
 * Audit 8, C2/C10/C13: a support session (the platform owner inside a salon)
 * ends at its 2-hour cap, when the platform owner's own sessions end, and only
 * renews from its own salon's cookie.
 */
const NOW_S = () => Math.floor(Date.now() / 1000);

function build(payload: Record<string, unknown>, impersonator: Record<string, unknown> | null, salon: Record<string, unknown> = { allowSupportAccess: true }) {
  const owner = { id: "owner-1", email: "o@salon.test", role: "owner", tenantId: "t1", isActive: true, tokenVersion: 0, professional: null };
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => salon) },
    user: {
      findUnique: jest.fn(async (args: any) => {
        if (args.where.id === "owner-1") return owner;
        if (args.where.id === "saas-1") return impersonator;
        return null;
      }),
    },
  };
  const sign = jest.fn((_claims: any, _opts: any) => "signed");
  const jwtService: any = { verify: jest.fn(() => payload), sign };
  const sessions: any = {
    start: jest.fn(async () => ({ sid: "s", jti: "j" })),
    rotate: jest.fn(async () => ({ kind: "rotated", jti: "j2" })),
  };
  const auth = new AuthService(prisma, jwtService, {} as any, {} as any, {} as any, sessions, {} as any);
  return { auth, sign, sessions };
}

const support = (over: Record<string, unknown> = {}) => ({
  sub: "owner-1",
  role: "owner",
  tenantId: "t1",
  tv: 0,
  typ: "refresh",
  sid: "s",
  jti: "j",
  impersonatedBy: "saas-1",
  impersonationId: "imp-1",
  impersonatedTenantId: "t1",
  impersonationEndsAt: NOW_S() + 600,
  impersonatorTv: 4,
  ...over,
});
const saasOwner = { role: "saas_owner", isActive: true, tokenVersion: 4 };

describe("support session refresh", () => {
  it("renews from its salon's cookie, never past the cap", async () => {
    const { auth, sign, sessions } = build(support(), saasOwner);
    await auth.refreshToken("tok", { supportTenantId: "t1" });
    for (const [, opts] of sign.mock.calls) expect(opts.expiresIn).toBeLessThanOrEqual(600);
    const rotatedUntil: Date = sessions.rotate.mock.calls[0][2];
    expect(rotatedUntil.getTime()).toBeLessThanOrEqual((NOW_S() + 601) * 1000);
  });

  it("ends at the cap", async () => {
    const { auth } = build(support({ impersonationEndsAt: NOW_S() - 1 }), saasOwner);
    await expect(auth.refreshToken("tok", { supportTenantId: "t1" })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("ends when the platform owner logged out everywhere or changed the password", async () => {
    const { auth } = build(support(), { ...saasOwner, tokenVersion: 5 });
    await expect(auth.refreshToken("tok", { supportTenantId: "t1" })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("is not renewed from the console's cookie, nor another salon's", async () => {
    await expect(build(support(), saasOwner).auth.refreshToken("tok")).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      build(support(), saasOwner).auth.refreshToken("tok", { supportTenantId: "t2" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("a support token from before the cap existed is refused", async () => {
    const legacy = support();
    delete (legacy as any).impersonationEndsAt;
    await expect(build(legacy, saasOwner).auth.refreshToken("tok", { supportTenantId: "t1" })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("an access token cannot refresh (C11)", async () => {
    const { auth } = build({ sub: "owner-1", role: "owner", tv: 0, typ: "access" }, null);
    await expect(auth.refreshToken("tok")).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("JwtStrategy and support sessions", () => {
  const user = { id: "owner-1", email: "o@salon.test", role: "owner", tenantId: "t1", isActive: true, tokenVersion: 0, tenant: { plan: "pro", subscriptionStatus: "active", deletedAt: null } };
  const strategy = (impersonator: any) =>
    new JwtStrategy(
      { get: () => "secret-of-sufficient-length-for-tests" } as any,
      {
        user: {
          findUnique: jest.fn(async (a: any) => (a.where.id === "owner-1" ? user : a.where.id === "saas-1" ? impersonator : null)),
        },
      } as any,
    );
  const access = (over: Record<string, unknown> = {}) => ({ ...support(over), typ: "access", sid: undefined, jti: undefined }) as any;

  it("accepts a live support session", async () => {
    await expect(strategy(saasOwner).validate(access())).resolves.toMatchObject({ impersonatedBy: "saas-1" });
  });

  it("refuses one whose platform owner's sessions ended (C13)", async () => {
    await expect(strategy({ ...saasOwner, tokenVersion: 9 }).validate(access())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(strategy({ ...saasOwner, isActive: false }).validate(access())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses the 2FA step's token and the support entry token as sessions (C11)", async () => {
    const s = strategy(saasOwner);
    await expect(s.validate({ sub: "owner-1", purpose: "2fa-login", aud: "kira-2fa-login" } as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      s.validate({ sub: "saas-1", aud: "impersonation", impersonate: { tenantId: "t1", ownerId: "owner-1" } } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
