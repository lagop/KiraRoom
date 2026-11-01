import "reflect-metadata";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { bodyParser } from "../common/validation/validated-body.testing";

/**
 * PATCH /auth/password: a panel user changing their own password. There
 * was no way to: a professional kept the first password the owner chose and
 * handed over, so the owner knew it for good.
 */

process.env.BCRYPT_ROUNDS = "4";
const HASH = bcrypt.hashSync("clave-actual-2026", 4);

function build(overrides: Record<string, unknown> = {}) {
  const user = {
    id: "u-ana",
    email: "ana@salon.test",
    firstName: "Ana",
    lastName: "P",
    role: "staff",
    tenantId: "t1",
    isActive: true,
    passwordHash: HASH,
    loginAttempts: 0,
    lockedUntil: null,
    tokenVersion: 3,
    professional: { id: "p-ana" },
    ...overrides,
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue({}),
    },
    client: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const jwtService: any = { sign: jest.fn().mockReturnValue("signed-jwt"), verify: jest.fn() };
  const sessions: any = { start: jest.fn(async () => ({ sid: "sid-new", jti: "jti-new" })), revoke: jest.fn() };
  const auth = new AuthService(prisma, jwtService, {} as any, {} as any, {} as any, sessions, {} as any);
  return { auth, prisma, jwtService, sessions };
}

describe("AuthService.changeOwnPassword", () => {
  it("needs the current password; a wrong one is a 400 (not 401) and counts towards the lockout", async () => {
    const { auth, prisma } = build();
    const err = await auth.changeOwnPassword("u-ana", "otra-cosa", "nueva-clave-2026").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/actual no es correcta/);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u-ana" },
      data: { loginAttempts: { increment: 1 }, lockedUntil: null },
    });
  });

  it("refuses while the account is locked, even with the right password", async () => {
    const { auth, prisma } = build({ lockedUntil: new Date(Date.now() + 10 * 60_000) });
    await expect(auth.changeOwnPassword("u-ana", "clave-actual-2026", "nueva-clave-2026")).rejects.toThrow(
      /Demasiados intentos/,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses the same password again", async () => {
    const { auth } = build();
    await expect(auth.changeOwnPassword("u-ana", "clave-actual-2026", "clave-actual-2026")).rejects.toThrow(
      /distinta/,
    );
  });

  it("stores the new one, ends every session and starts a new one for this browser", async () => {
    const { auth, prisma, sessions } = build();
    const out = await auth.changeOwnPassword("u-ana", "clave-actual-2026", "nueva-clave-2026");

    const { data } = prisma.user.update.mock.calls[0][0];
    expect(await bcrypt.compare("nueva-clave-2026", data.passwordHash)).toBe(true);
    expect(data.tokenVersion).toEqual({ increment: 1 });
    expect(sessions.start).toHaveBeenCalledTimes(1);
    expect(out.tokens.accessToken).toBe("signed-jwt");
    expect(out.user).toMatchObject({ id: "u-ana", role: "staff" });
  });
});

describe("PATCH /auth/password", () => {
  const parse = bodyParser(AuthController, "changeOwnPassword");

  it("asks for the same minimum as signing up", async () => {
    await expect(parse({ currentPassword: "x", newPassword: "corta" })).rejects.toBeDefined();
    await expect(parse({ newPassword: "nueva-clave-2026" })).rejects.toBeDefined();
    expect(await parse({ currentPassword: "x", newPassword: "nueva-clave-2026" })).toMatchObject({
      newPassword: "nueva-clave-2026",
    });
  });

  function controller() {
    const authService: any = {
      changeOwnPassword: jest.fn(async () => ({
        user: { id: "u-ana", role: "staff" },
        tokens: { accessToken: "a", refreshToken: "r", refreshExpiresIn: 60, expiresIn: 900, tokenType: "Bearer" },
      })),
      endSession: jest.fn(async () => undefined),
    };
    return { ctl: new AuthController(authService, {} as any, {} as any), authService };
  }
  const res = () => ({ cookie: jest.fn(), clearCookie: jest.fn() }) as any;
  const req = { headers: {}, cookies: {} } as any;
  const dto = { currentPassword: "clave-actual-2026", newPassword: "nueva-clave-2026" };

  it("keeps this browser signed in: the new access token in the body, the refresh token in its cookie", async () => {
    const { ctl } = controller();
    const r = res();
    const out: any = await ctl.changeOwnPassword({ id: "u-ana", role: "staff" }, dto, req, r);
    expect(out.tokens.accessToken).toBe("a");
    expect(out.tokens.refreshToken).toBeUndefined();
    expect(r.cookie).toHaveBeenCalled();
  });

  it("is not for a salon's clients, nor for a support session", async () => {
    const { ctl, authService } = controller();
    await expect(ctl.changeOwnPassword({ id: "c1", role: "client" }, dto, req, res())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      ctl.changeOwnPassword({ id: "u-owner", role: "owner", impersonatedBy: "saas-1" }, dto, req, res()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(authService.changeOwnPassword).not.toHaveBeenCalled();
  });
});
