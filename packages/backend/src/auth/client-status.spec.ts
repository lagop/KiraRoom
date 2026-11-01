import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";

/**
 * A client the salon marks inactive could still sign in and use her session:
 * only "blocked" was refused, and only by the token check.
 */
const HASH = bcrypt.hashSync("correct-horse-battery", 4);

function client(status: string) {
  return {
    id: "c1",
    email: "ana@mail.test",
    firstName: "Ana",
    lastName: "Gil",
    tenantId: "t1",
    status,
    tokenVersion: 0,
    passwordHash: HASH,
  };
}

function auth(row: any, verified: any = null) {
  const prisma: any = {
    user: { findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => null), update: jest.fn() },
    client: { findFirst: jest.fn(async () => row), findUnique: jest.fn(async () => row) },
    tenant: { findFirst: jest.fn(async () => null) },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(async (arg: any) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
  };
  const jwt: any = { sign: jest.fn(() => "signed"), verify: jest.fn(() => verified) };
  const sessions: any = { start: jest.fn(async () => ({ sid: "s1", jti: "j1" })), rotate: jest.fn(async () => ({ sid: "s1", jti: "j2" })) };
  return new AuthService(
    prisma,
    jwt,
    { record: jest.fn() } as any,
    { record: jest.fn(), recordOnce: jest.fn() } as any,
    {} as any,
    sessions,
    {} as any,
  );
}

describe("inactive and blocked clients", () => {
  it.each(["inactive", "blocked"])("a %s client cannot sign in, even with the right password", async (status) => {
    await expect(
      auth(client(status)).login({ email: "ana@mail.test", password: "correct-horse-battery" } as any),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("an active client signs in", async () => {
    await expect(
      auth(client("active")).login({ email: "ana@mail.test", password: "correct-horse-battery" } as any),
    ).resolves.toMatchObject({ user: { id: "c1", role: "client" } });
  });

  it.each(["inactive", "blocked"])("a %s client's token and refresh token stop working", async (status) => {
    const strategy = new JwtStrategy(
      { get: () => "secret-of-sufficient-length-1234567890" } as any,
      { client: { findUnique: jest.fn(async () => client(status)) } } as any,
    );
    await expect(strategy.validate({ sub: "c1", role: "client", tv: 0 } as any)).rejects.toMatchObject({ status: 401 });
    await expect(auth(client(status), { sub: "c1", role: "client", tv: 0 }).refreshToken("r")).rejects.toMatchObject({
      status: 401,
    });
  });
});
