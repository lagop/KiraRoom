import { noLimits, noTurnstile } from "../abuse/abuse-checks.testing";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import {
  base32Decode,
  base32Encode,
  codeForStep,
  generateRecoveryCodes,
  hashRecoveryCode,
  otpauthUrl,
  stepAt,
  verifyCode,
} from "./totp";
import { TwoFactorService } from "./two-factor.service";
import { AuthService } from "../auth.service";
import { AuthController } from "../auth.controller";
import { STAFF_REFRESH_COOKIE } from "../sessions/refresh-cookie";
import { withoutCredentials } from "../../saas/gdpr/gdpr.service";

/**
 * Two-step sign-in for panel users. The User table had twoFactorEnabled and
 * twoFactorSecret from its first migration and nothing used them.
 */

// RFC 6238, appendix B: the SHA-1 secret is the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC's SHA-1 test vectors (last 6 of the 8 digits)", () => {
    const vectors: Array<[number, string]> = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [t, code] of vectors) {
      expect(codeForStep(RFC_SECRET, stepAt(new Date(t * 1000)))).toBe(code);
    }
  });

  it("base32 round-trips, as authenticator apps expect it", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET).toString()).toBe("12345678901234567890");
    expect(base32Decode("gezd gnbv-gy3t")).toEqual(base32Decode("GEZDGNBVGY3T"));
  });

  it("accepts the step before and after (clock drift), not further", () => {
    const now = new Date(1111111111 * 1000);
    const step = stepAt(now);
    expect(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step - 2), now)).toBeNull();
    expect(verifyCode(RFC_SECRET, "12345", now)).toBeNull();
  });

  it("never accepts a step already used", () => {
    const now = new Date(1111111111 * 1000);
    const step = stepAt(now);
    expect(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step), now, step)).toBeNull();
  });

  it("builds the URL the app reads from the QR code", () => {
    const url = otpauthUrl("ABC", "duena@salon.test");
    expect(url.startsWith("otpauth://totp/KiraRoom%3Aduena%40salon.test?")).toBe(true);
    expect(new URL(url).searchParams.get("secret")).toBe("ABC");
    expect(new URL(url).searchParams.get("issuer")).toBe("KiraRoom");
  });

  it("recovery codes are 10, readable, and stored as normalised hashes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(hashRecoveryCode("K7M2-9QXR")).toBe(hashRecoveryCode(" k7m2 9qxr"));
  });
});

/** Users with the fields the service touches; updateMany honours its where. */
function usersDb(row: Record<string, any>) {
  const user: Record<string, any> = {
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorPendingSecret: null,
    twoFactorLastStep: null,
    twoFactorRecoveryCodes: [],
    loginAttempts: 0,
    lockedUntil: null,
    isActive: true,
    professional: null,
    ...row,
  };
  const matches = (where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) =>
      k === "id" ? user.id === v : v && typeof v === "object" && "has" in v ? user[k].includes(v.has) : user[k] === v,
    );
  return {
    user,
    prisma: {
      user: {
        findUnique: jest.fn(async () => ({ ...user })),
        update: jest.fn(async ({ data }: any) => {
          for (const [k, v] of Object.entries(data)) {
            user[k] = v && typeof v === "object" && "increment" in (v as any) ? user[k] + (v as any).increment : v;
          }
          return { ...user };
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (!matches(where)) return { count: 0 };
          Object.assign(user, data);
          return { count: 1 };
        }),
      },
    },
  };
}

// Stands in for EncryptionService: what matters is that the stored value is not the secret.
const encryption = { encrypt: (s: string) => `enc:${Buffer.from(s).toString("base64")}`, decrypt: (s: string) => Buffer.from(s.slice(4), "base64").toString() };

async function enabledUser(password = "contraseña-de-prueba") {
  const db = usersDb({ id: "u1", email: "duena@salon.test", role: "owner", tenantId: "t1", firstName: "Ana", lastName: "Prueba", passwordHash: await bcrypt.hash(password, 4) });
  const svc = new TwoFactorService(db.prisma as any, encryption as any);
  const { secret } = await svc.setup("u1");
  const t0 = new Date("2026-10-24T10:00:00Z");
  const { recoveryCodes } = await svc.enable("u1", codeForStep(secret, stepAt(t0)), t0);
  return { db, svc, secret, recoveryCodes, t0, password };
}

describe("TwoFactorService", () => {
  it("turning it on takes a correct code; until then nothing changes", async () => {
    const db = usersDb({ id: "u1", email: "duena@salon.test" });
    const svc = new TwoFactorService(db.prisma as any, encryption as any);
    const { secret, otpauthUrl: url } = await svc.setup("u1");
    expect(url).toContain(secret);
    expect(db.user.twoFactorEnabled).toBe(false);
    expect(db.user.twoFactorPendingSecret).not.toContain(secret);

    const now = new Date("2026-10-24T10:00:00Z");
    await expect(svc.enable("u1", "000000", now)).rejects.toThrow(/no es correcto/);
    expect(db.user.twoFactorEnabled).toBe(false);

    const { recoveryCodes } = await svc.enable("u1", codeForStep(secret, stepAt(now)), now);
    expect(recoveryCodes).toHaveLength(10);
    expect(db.user.twoFactorEnabled).toBe(true);
    expect(db.user.twoFactorPendingSecret).toBeNull();
    expect(db.user.twoFactorRecoveryCodes).toEqual(recoveryCodes.map(hashRecoveryCode));
    expect(await svc.status("u1")).toEqual({ enabled: true, recoveryCodesLeft: 10 });
  });

  it("a code works once; a recovery code works once", async () => {
    const { svc, secret, recoveryCodes, t0 } = await enabledUser();
    const later = new Date(t0.getTime() + 60_000);
    const code = codeForStep(secret, stepAt(later));
    expect(await svc.verifyForLogin("u1", code, later)).toBe(true);
    expect(await svc.verifyForLogin("u1", code, later)).toBe(false);

    expect(await svc.verifyForLogin("u1", recoveryCodes[0].toUpperCase(), later)).toBe(true);
    expect(await svc.verifyForLogin("u1", recoveryCodes[0], later)).toBe(false);
    expect((await svc.status("u1")).recoveryCodesLeft).toBe(9);
  });

  it("turning it off needs the password and a code", async () => {
    const { db, svc, secret, t0, password } = await enabledUser();
    const later = new Date(t0.getTime() + 60_000);
    await expect(svc.disable("u1", "otra", codeForStep(secret, stepAt(later)), later)).rejects.toThrow(/contraseña/);
    await expect(svc.disable("u1", password, "000000", later)).rejects.toThrow(/código/);
    expect(db.user.twoFactorEnabled).toBe(true);
    await svc.disable("u1", password, codeForStep(secret, stepAt(later)), later);
    expect(db.user).toMatchObject({ twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: [] });
  });
});

describe("sign-in with two-step verification", () => {
  const JWT_SECRET = ["unit", "test", "jwt", "key"].join("-").repeat(2);

  async function auth() {
    const ctx = await enabledUser();
    const jwt = new JwtService({ secret: JWT_SECRET });
    const sessions = { start: jest.fn(async () => ({ sid: "s1", jti: "j1" })) };
    ctx.db.prisma.user.findUnique.mockImplementation(async () => ({ ...ctx.db.user }));
    const prisma = { ...ctx.db.prisma, client: { findFirst: jest.fn(async () => null) } };
    const service = new AuthService(prisma as any, jwt, {} as any, {} as any, {} as any, sessions as any, ctx.svc);
    return { ...ctx, service, jwt };
  }

  it("the right password answers a challenge, not a session", async () => {
    const { service, password, db } = await auth();
    db.user.loginAttempts = 2;
    const out: any = await service.login({ email: "duena@salon.test", password } as any);
    expect(out).toEqual({ twoFactorRequired: true, challenge: expect.any(String) });
    expect(out.tokens).toBeUndefined();
    // Attempts are not reset by the password alone.
    expect(db.user.loginAttempts).toBe(2);
  });

  it("the challenge and a current code give the session", async () => {
    const { service, password, secret } = await auth();
    const { challenge }: any = await service.login({ email: "duena@salon.test", password } as any);
    const code = codeForStep(secret, stepAt(new Date()));
    const out = await service.completeTwoFactorLogin(challenge, code);
    expect(out.user.email).toBe("duena@salon.test");
    expect(out.tokens.accessToken).toBeDefined();
  });

  it("wrong codes count towards the lockout", async () => {
    const { service, password, db } = await auth();
    const { challenge }: any = await service.login({ email: "duena@salon.test", password } as any);
    for (let i = 0; i < 5; i++) {
      await expect(service.completeTwoFactorLogin(challenge, "000000")).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(db.user.lockedUntil).toBeInstanceOf(Date);
    await expect(service.completeTwoFactorLogin(challenge, "000000")).rejects.toThrow(/bloqueada/);
  });

  it("an expired or foreign challenge is refused", async () => {
    const { service, jwt, secret } = await auth();
    const code = codeForStep(secret, stepAt(new Date()));
    const expired = jwt.sign({ sub: "u1", purpose: "2fa-login" }, { audience: "kira-2fa-login", expiresIn: -10 });
    await expect(service.completeTwoFactorLogin(expired, code)).rejects.toThrow(/5 minutos/);
    const accessToken = jwt.sign({ sub: "u1", role: "owner" });
    await expect(service.completeTwoFactorLogin(accessToken, code)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("AuthController with two-step verification", () => {
  function controller(loginResult: any) {
    const authService = {
      login: jest.fn(async () => loginResult),
      completeTwoFactorLogin: jest.fn(async () => ({
        user: { id: "u1", email: "e", firstName: "", lastName: "", role: "owner", tenantId: "t1" },
        tokens: { accessToken: "a", refreshToken: "r", refreshExpiresIn: 600, expiresIn: 900, tokenType: "Bearer" },
      })),
    };
    const twoFactor = { status: jest.fn(async () => ({ enabled: false, recoveryCodesLeft: 0 })) };
    const res = { cookie: jest.fn() };
    return { c: new AuthController(authService as any, {} as any, twoFactor as any, noTurnstile(), noLimits()), res, authService };
  }

  it("a challenge sets no cookie; the verified code does", async () => {
    const { c, res } = controller({ twoFactorRequired: true, challenge: "ch" });
    expect(await c.login({ email: "e", password: "p" } as any, res as any)).toEqual({ twoFactorRequired: true, challenge: "ch" });
    expect(res.cookie).not.toHaveBeenCalled();
    const out: any = await c.verifyTwoFactor({ challenge: "ch", code: "123456" } as any, res as any);
    expect(res.cookie).toHaveBeenCalledWith(STAFF_REFRESH_COOKIE, "r", expect.anything());
    expect(out.tokens.refreshToken).toBeUndefined();
  });

  it("a salon's client cannot use the panel's two-step settings", async () => {
    const { c } = controller(null);
    await expect(c.twoFactorStatus({ id: "c1", role: "client" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.twoFactorStatus({ id: "u1", role: "owner" })).resolves.toEqual({ enabled: false, recoveryCodesLeft: 0 });
  });
});

describe("GDPR export", () => {
  it("leaves out sign-in credentials", () => {
    const out = withoutCredentials({
      id: "u1",
      email: "e",
      passwordHash: "x",
      twoFactorSecret: "x",
      twoFactorPendingSecret: "x",
      twoFactorRecoveryCodes: ["x"],
      passwordResetToken: "x",
    });
    expect(out).toEqual({ id: "u1", email: "e" });
  });
});

/**
 * Turning two-step verification on or off ends the account's other sessions,
 * as a password change does (B21): a stolen session must not outlive the
 * owner turning it on. This browser goes on with new tokens.
 */
describe("two-step verification on or off ends the other sessions", () => {
  it("enable and disable raise tokenVersion", async () => {
    const db = usersDb({ id: "u1", email: "duena@salon.test", tokenVersion: 4, passwordHash: await bcrypt.hash("clave", 4) });
    const svc = new TwoFactorService(db.prisma as any, encryption as any);
    const { secret } = await svc.setup("u1");
    expect(db.user.tokenVersion).toBe(4); // a pending secret changes nothing yet
    const t0 = new Date("2026-10-24T10:00:00Z");
    await svc.enable("u1", codeForStep(secret, stepAt(t0)), t0);
    expect(db.user.tokenVersion).toBe(5);
    const later = new Date(t0.getTime() + 60_000);
    await svc.disable("u1", "clave", codeForStep(secret, stepAt(later)), later);
    expect(db.user.tokenVersion).toBe(6);
  });

  function controller(user: Record<string, unknown> = {}) {
    const session = {
      user: { id: "u1", email: "e", firstName: "", lastName: "", role: "owner", tenantId: "t1" },
      tokens: { accessToken: "a2", refreshToken: "r2", refreshExpiresIn: 600, expiresIn: 900, tokenType: "Bearer" },
    };
    const authService = {
      endSession: jest.fn(async () => undefined),
      sessionAfterSignInChange: jest.fn(async () => session),
    };
    const twoFactor = {
      setup: jest.fn(async () => ({ secret: "s", otpauthUrl: "u" })),
      enable: jest.fn(async () => ({ recoveryCodes: ["a", "b"] })),
      disable: jest.fn(async () => ({ enabled: false, recoveryCodesLeft: 0 })),
      regenerateRecoveryCodes: jest.fn(async () => ({ recoveryCodes: ["c"] })),
    };
    const res = { cookie: jest.fn() };
    const req = { headers: { cookie: `${STAFF_REFRESH_COOKIE}=old-refresh` } };
    const c = new AuthController(authService as any, {} as any, twoFactor as any, noTurnstile(), noLimits());
    return { c, authService, twoFactor, res, req, panelUser: { id: "u1", role: "owner", ...user } };
  }

  it("enable answers the recovery codes and a new session for this browser", async () => {
    const { c, authService, res, req, panelUser } = controller();
    const out: any = await c.twoFactorEnable(panelUser, { code: "123456" } as any, req as any, res as any);
    expect(out.recoveryCodes).toEqual(["a", "b"]);
    expect(authService.endSession).toHaveBeenCalledWith("old-refresh");
    expect(authService.sessionAfterSignInChange).toHaveBeenCalledWith("u1");
    expect(res.cookie).toHaveBeenCalledWith(STAFF_REFRESH_COOKIE, "r2", expect.anything());
    expect(out.tokens).toMatchObject({ accessToken: "a2" });
    expect(out.tokens.refreshToken).toBeUndefined();
  });

  it("disable too", async () => {
    const { c, authService, res, req, panelUser } = controller();
    const out: any = await c.twoFactorDisable(panelUser, { password: "p", code: "123456" } as any, req as any, res as any);
    expect(out).toMatchObject({ enabled: false, tokens: { accessToken: "a2" } });
    expect(authService.sessionAfterSignInChange).toHaveBeenCalledWith("u1");
  });

  it("a failed code starts no new session", async () => {
    const { c, authService, twoFactor, res, req, panelUser } = controller();
    twoFactor.enable.mockRejectedValueOnce(new Error("El código no es correcto."));
    await expect(c.twoFactorEnable(panelUser, { code: "000000" } as any, req as any, res as any)).rejects.toThrow();
    expect(authService.sessionAfterSignInChange).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  /**
   * A support session (impersonation) cannot touch the owner's two-step
   * verification (B12), as it cannot change her password: it could lock
   * her out of her own account.
   */
  it("a support session cannot set up, enable, disable or replace recovery codes", async () => {
    const { c, twoFactor, res, req, panelUser } = controller({ impersonatedBy: "saas-owner" });
    const calls: Array<Promise<unknown>> = [
      c.twoFactorSetup(panelUser),
      c.twoFactorEnable(panelUser, { code: "123456" } as any, req as any, res as any),
      c.twoFactorDisable(panelUser, { password: "p", code: "123456" } as any, req as any, res as any),
      c.twoFactorRecoveryCodes(panelUser, { code: "123456" } as any),
    ];
    for (const call of calls) {
      const err: any = await call.catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toMatch(/sesión de soporte/);
    }
    expect(twoFactor.setup).not.toHaveBeenCalled();
    expect(twoFactor.enable).not.toHaveBeenCalled();
    expect(twoFactor.disable).not.toHaveBeenCalled();
    expect(twoFactor.regenerateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("support can still see whether it is on", async () => {
    const authService = {};
    const twoFactor = { status: jest.fn(async () => ({ enabled: true, recoveryCodesLeft: 3 })) };
    const c = new AuthController(authService as any, {} as any, twoFactor as any, noTurnstile(), noLimits());
    await expect(c.twoFactorStatus({ id: "u1", role: "owner", impersonatedBy: "x" } as any)).resolves.toEqual({
      enabled: true,
      recoveryCodesLeft: 3,
    });
  });
});

describe("AuthService.sessionAfterSignInChange", () => {
  it("issues tokens for an active user, with the raised tokenVersion", async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => ({
          id: "u1", email: "e@salon.test", firstName: "Ana", lastName: "P", role: "owner", tenantId: "t1",
          isActive: true, tokenVersion: 7, professional: null,
        })),
      },
    };
    const jwtService: any = { sign: jest.fn(() => "signed") };
    const sessions: any = { start: jest.fn(async () => ({ sid: "s", jti: "j" })) };
    const auth = new AuthService(prisma, jwtService, {} as any, {} as any, {} as any, sessions, {} as any);
    const out = await auth.sessionAfterSignInChange("u1");
    expect(out.user).toMatchObject({ id: "u1", tenantId: "t1" });
    expect(jwtService.sign.mock.calls[0][0]).toMatchObject({ sub: "u1", tv: 7 });
    expect(sessions.start).toHaveBeenCalledTimes(1);
  });

  it("refuses a deactivated user", async () => {
    const prisma: any = { user: { findUnique: jest.fn(async () => ({ id: "u1", isActive: false })) } };
    const auth = new AuthService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(auth.sessionAfterSignInChange("u1")).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
