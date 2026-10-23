import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthSessionsService, ROTATION_GRACE_MS } from "./auth-sessions.service";
import { CLIENT_REFRESH_COOKIE, STAFF_REFRESH_COOKIE, deliverTokens, readRefreshCookie } from "./refresh-cookie";
import { AuthService } from "../auth.service";
import { AuthController } from "../auth.controller";

/**
 * The refresh token left localStorage, where any script on the page could
 * read it and keep the account for 7 days. It now travels in an httpOnly
 * cookie and works once: every refresh replaces it, and a replaced one
 * presented again ends that session.
 */

/** In-memory auth_sessions with the semantics the service relies on. */
function sessionsPrisma() {
  const rows = new Map<string, any>();
  let n = 0;
  const matches = (r: any, where: any) =>
    r.id === where.id &&
    (where.currentJti === undefined || r.currentJti === where.currentJti) &&
    (where.revokedAt !== null || r.revokedAt === null) &&
    (!where.expiresAt?.gt || r.expiresAt > where.expiresAt.gt);
  return {
    rows,
    authSession: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `sid-${++n}`, previousJti: null, rotatedAt: null, revokedAt: null, ...data };
        rows.set(row.id, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = rows.get(where.id);
        if (!r || !matches(r, where)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(rows.get(where.id), data)),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        for (const [id, r] of rows) {
          if (where.OR.some((c: any) => (c.expiresAt && r.expiresAt < c.expiresAt.lt) || (c.revokedAt && r.revokedAt && r.revokedAt < c.revokedAt.lt))) {
            rows.delete(id);
            count++;
          }
        }
        return { count };
      }),
    },
  };
}

const LATER = new Date(Date.now() + 7 * 24 * 3600 * 1000);

describe("AuthSessionsService.rotate", () => {
  it("swaps the jti, so a refresh token works once", async () => {
    const prisma = sessionsPrisma();
    const svc = new AuthSessionsService(prisma as any);
    const { sid, jti } = await svc.start({ id: "u1", type: "user" }, LATER);

    const first = await svc.rotate(sid, jti, LATER);
    expect(first.kind).toBe("rotated");
    expect((first as any).jti).not.toBe(jti);
    expect(prisma.rows.get(sid).currentJti).toBe((first as any).jti);
  });

  it("two tabs refreshing at once: the second gets the grace path, not a revocation", async () => {
    const prisma = sessionsPrisma();
    const svc = new AuthSessionsService(prisma as any);
    const { sid, jti } = await svc.start({ id: "u1", type: "user" }, LATER);
    const now = new Date();

    const [a, b] = await Promise.all([svc.rotate(sid, jti, LATER, now), svc.rotate(sid, jti, LATER, now)]);
    expect([a.kind, b.kind].sort()).toEqual(["grace", "rotated"]);
    expect(prisma.rows.get(sid).revokedAt).toBeNull();
  });

  it("a replaced token after the grace window is a copy: the session is revoked", async () => {
    const prisma = sessionsPrisma();
    const svc = new AuthSessionsService(prisma as any);
    const { sid, jti } = await svc.start({ id: "u1", type: "user" }, LATER);
    const t0 = new Date();
    const rotated = (await svc.rotate(sid, jti, LATER, t0)) as { jti: string };

    const later = new Date(t0.getTime() + ROTATION_GRACE_MS + 1);
    await expect(svc.rotate(sid, jti, LATER, later)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.rows.get(sid).revokedAt).toEqual(later);
    // ...and the legitimate holder of the newest token is out too.
    await expect(svc.rotate(sid, rotated.jti, LATER, later)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses a revoked, expired or unknown session", async () => {
    const prisma = sessionsPrisma();
    const svc = new AuthSessionsService(prisma as any);
    const s = await svc.start({ id: "u1", type: "user" }, LATER);
    await svc.revoke(s.sid);
    await expect(svc.rotate(s.sid, s.jti, LATER)).rejects.toBeInstanceOf(UnauthorizedException);

    const e = await svc.start({ id: "u1", type: "user" }, new Date(Date.now() - 1000));
    await expect(svc.rotate(e.sid, e.jti, LATER)).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(svc.rotate("nope", "x", LATER)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("deletes sessions ended more than a day ago", async () => {
    const prisma = sessionsPrisma();
    const svc = new AuthSessionsService(prisma as any);
    const old = await svc.start({ id: "u1", type: "user" }, new Date(Date.now() - 3 * 24 * 3600 * 1000));
    const live = await svc.start({ id: "u1", type: "user" }, LATER);
    await svc.purgeEnded();
    expect(prisma.rows.has(old.sid)).toBe(false);
    expect(prisma.rows.has(live.sid)).toBe(true);
  });
});

describe("refresh cookie helpers", () => {
  it("reads its own cookie among others, and nothing when absent", () => {
    const req = { headers: { cookie: `a=1; ${STAFF_REFRESH_COOKIE}=staff.tok; ${CLIENT_REFRESH_COOKIE}=client.tok` } };
    expect(readRefreshCookie(req as any, "staff")).toBe("staff.tok");
    expect(readRefreshCookie(req as any, "client")).toBe("client.tok");
    expect(readRefreshCookie({ headers: {} } as any, "staff")).toBeUndefined();
  });

  it("sets an httpOnly, Lax cookie on the auth path and drops the token from the body", () => {
    const res = { cookie: jest.fn() };
    const body = deliverTokens(res as any, "staff", {
      accessToken: "a",
      refreshToken: "r",
      refreshExpiresIn: 600,
      expiresIn: 900,
      tokenType: "Bearer",
    });
    expect(body).toEqual({ accessToken: "a", expiresIn: 900, tokenType: "Bearer" });
    expect(res.cookie).toHaveBeenCalledWith(
      STAFF_REFRESH_COOKIE,
      "r",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/api/v1/auth", maxAge: 600_000 }),
    );
  });
});

describe("AuthService.refreshToken with sessions", () => {
  const OLD_ENV = { ...process.env };
  beforeAll(() => {
    process.env.JWT_REFRESH_SECRET = "refresh-secret-for-tests-0123456789";
    process.env.JWT_EXPIRES_IN = "15m";
    process.env.JWT_REFRESH_EXPIRES_IN = "7d";
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  function setup() {
    const jwt = new JwtService({ secret: "access-secret-for-tests-0123456789" });
    const sessionsDb = sessionsPrisma();
    const user = { id: "u1", email: "duena@salon.test", role: "owner", tenantId: "t1", isActive: true, tokenVersion: 0, professional: null };
    const prisma = {
      ...sessionsDb,
      user: { findUnique: jest.fn(async () => user) },
      client: { findUnique: jest.fn(async () => null) },
    };
    const sessions = new AuthSessionsService(prisma as any);
    const auth = new AuthService(prisma as any, jwt, {} as any, {} as any, {} as any, sessions);
    return { auth, jwt, sessionsDb };
  }

  const refreshPayload = (jwt: JwtService, token: string) =>
    jwt.verify(token, { secret: process.env.JWT_REFRESH_SECRET }) as any;

  it("a token from before this change (no sid) is still accepted and starts a session", async () => {
    const { auth, jwt, sessionsDb } = setup();
    const legacy = jwt.sign({ sub: "u1", email: "duena@salon.test", role: "owner", tenantId: "t1", tv: 0 }, { secret: process.env.JWT_REFRESH_SECRET, expiresIn: "7d" });
    const out = await auth.refreshToken(legacy);
    expect(out.refreshToken).toBeDefined();
    const p = refreshPayload(jwt, out.refreshToken!);
    expect(sessionsDb.rows.get(p.sid)?.currentJti).toBe(p.jti);
  });

  it("each refresh returns a new token, and the old one is refused after the grace window", async () => {
    const { auth, jwt, sessionsDb } = setup();
    const legacy = jwt.sign({ sub: "u1", email: "duena@salon.test", role: "owner", tenantId: "t1", tv: 0 }, { secret: process.env.JWT_REFRESH_SECRET, expiresIn: "7d" });
    const first = (await auth.refreshToken(legacy)).refreshToken!;
    const second = await auth.refreshToken(first);
    expect(second.refreshToken).toBeDefined();
    expect(refreshPayload(jwt, second.refreshToken!).jti).not.toBe(refreshPayload(jwt, first).jti);

    // Inside the grace window: an access token, no new refresh token.
    const again = await auth.refreshToken(first);
    expect(again.accessToken).toBeDefined();
    expect(again.refreshToken).toBeUndefined();

    // After it: refused, and the session is gone.
    const sid = refreshPayload(jwt, first).sid;
    sessionsDb.rows.get(sid).rotatedAt = new Date(Date.now() - ROTATION_GRACE_MS - 1000);
    await expect(auth.refreshToken(first)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.refreshToken(second.refreshToken!)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("endSession revokes the session its token names, and ignores junk", async () => {
    const { auth, jwt, sessionsDb } = setup();
    const legacy = jwt.sign({ sub: "u1", email: "duena@salon.test", role: "owner", tenantId: "t1", tv: 0 }, { secret: process.env.JWT_REFRESH_SECRET, expiresIn: "7d" });
    const token = (await auth.refreshToken(legacy)).refreshToken!;
    await auth.endSession(token);
    expect(sessionsDb.rows.get(refreshPayload(jwt, token).sid).revokedAt).toBeInstanceOf(Date);
    await expect(auth.refreshToken(token)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.endSession("not-a-jwt")).resolves.toBeUndefined();
  });
});

describe("AuthController refresh, login and logout", () => {
  function controller(refreshImpl?: jest.Mock) {
    const authService = {
      refreshToken: refreshImpl ?? jest.fn(async () => ({ accessToken: "a2", refreshToken: "r2", refreshExpiresIn: 600, expiresIn: 900, tokenType: "Bearer" })),
      login: jest.fn(async () => ({
        user: { id: "c1", email: "x@y.test", firstName: "", lastName: "", role: "client", tenantId: "t1" },
        tokens: { accessToken: "a", refreshToken: "r", refreshExpiresIn: 600, expiresIn: 900, tokenType: "Bearer" },
      })),
      endSession: jest.fn(async () => undefined),
      logoutEverywhere: jest.fn(async () => undefined),
    };
    const c = new AuthController(authService as any, {} as any);
    const res = { cookie: jest.fn(), clearCookie: jest.fn() };
    return { c, authService, res };
  }

  it("refresh reads the cookie of the kind asked for and sets the new one", async () => {
    const { c, authService, res } = controller();
    const req = { headers: { cookie: `${STAFF_REFRESH_COOKIE}=staff.tok; ${CLIENT_REFRESH_COOKIE}=client.tok` } };
    const out = await c.refreshToken({ kind: "client" }, req as any, res as any);
    expect(authService.refreshToken).toHaveBeenCalledWith("client.tok");
    expect(res.cookie).toHaveBeenCalledWith(CLIENT_REFRESH_COOKIE, "r2", expect.anything());
    expect(out).not.toHaveProperty("refreshToken");
  });

  it("a browser that still has the token in localStorage sends it in the body and moves to the cookie", async () => {
    const { c, authService, res } = controller();
    await c.refreshToken({ refreshToken: "legacy.tok" }, { headers: {} } as any, res as any);
    expect(authService.refreshToken).toHaveBeenCalledWith("legacy.tok");
    expect(res.cookie).toHaveBeenCalledWith(STAFF_REFRESH_COOKIE, "r2", expect.anything());
  });

  it("no token at all is a 401; a refused one also clears the cookie", async () => {
    const { c, res } = controller(jest.fn(async () => { throw new UnauthorizedException(); }));
    await expect(c.refreshToken({}, { headers: {} } as any, res as any)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      c.refreshToken({}, { headers: { cookie: `${STAFF_REFRESH_COOKIE}=bad` } } as any, res as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.clearCookie).toHaveBeenCalledWith(STAFF_REFRESH_COOKIE, expect.objectContaining({ path: "/api/v1/auth" }));
  });

  it("login puts the token in the cookie for the account's kind, not in the body", async () => {
    const { c, res } = controller();
    const out = await c.login({ email: "x@y.test", password: "secreto123" } as any, res as any);
    expect(res.cookie).toHaveBeenCalledWith(CLIENT_REFRESH_COOKIE, "r", expect.anything());
    expect(out.tokens).toEqual({ accessToken: "a", expiresIn: 900, tokenType: "Bearer" });
  });

  it("logout ends this browser's session and clears its cookie, leaving other devices signed in", async () => {
    const { c, authService, res } = controller();
    const req = { headers: { cookie: `${STAFF_REFRESH_COOKIE}=staff.tok` } };
    await c.logout({ id: "u1", role: "owner" }, undefined, req as any, res as any);
    expect(authService.endSession).toHaveBeenCalledWith("staff.tok");
    expect(authService.logoutEverywhere).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith(STAFF_REFRESH_COOKIE, expect.anything());

    await c.logout({ id: "u1", role: "owner" }, { everywhere: true }, req as any, res as any);
    expect(authService.logoutEverywhere).toHaveBeenCalledWith("u1", "owner");
  });
});
