import * as bcrypt from "bcryptjs";
import { PasswordResetService } from "./password-reset.service";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";

/**
 * There was no password reset for anyone, and logout revoked nothing (it
 * updated the user with an empty change, and failed for clients).
 */
function prisma(rows: { user?: any; client?: any; clients?: any[] } = {}) {
  return {
    user: {
      findFirst: jest.fn(async () => rows.user ?? null),
      findUnique: jest.fn(async () => rows.user ?? null),
      update: jest.fn(async () => ({})),
    },
    client: {
      findFirst: jest.fn(async () => rows.client ?? null),
      findUnique: jest.fn(async () => rows.client ?? null),
      findMany: jest.fn(async () => rows.clients ?? []),
      update: jest.fn(async () => ({})),
    },
  } as any;
}

const email = () => ({ sendPasswordReset: jest.fn(async () => ({ success: true })) }) as any;

describe("PasswordResetService.request", () => {
  it("emails a link and stores only the token's hash", async () => {
    const p = prisma({ user: { id: "u1", email: "ana@salon.test", firstName: "Ana" } });
    const mail = email();
    await new PasswordResetService(p, mail).request("Ana@Salon.test");

    const sent = mail.sendPasswordReset.mock.calls[0][0];
    const token = new URL(sent.resetUrl).searchParams.get("token")!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stored = p.user.update.mock.calls[0][0].data;
    expect(stored.passwordResetToken).toBe(PasswordResetService.hash(token));
    expect(stored.passwordResetToken).not.toBe(token);
    expect(stored.passwordResetExpires.getTime() - Date.now()).toBeLessThanOrEqual(PasswordResetService.TTL_MS);
  });

  it("sends one link per salon to a client with accounts in several", async () => {
    const p = prisma({
      clients: [
        { id: "c1", email: "c@x.test", firstName: "C", tenant: { name: "Uno" } },
        { id: "c2", email: "c@x.test", firstName: "C", tenant: { name: "Dos" } },
      ],
    });
    const mail = email();
    await new PasswordResetService(p, mail).request("c@x.test");
    expect(mail.sendPasswordReset).toHaveBeenCalledTimes(2);
    expect(mail.sendPasswordReset.mock.calls.map((c: any) => c[0].salon)).toEqual(["Uno", "Dos"]);
  });

  it("does nothing, and says nothing, for an unknown address", async () => {
    const p = prisma();
    const mail = email();
    await expect(new PasswordResetService(p, mail).request("nobody@x.test")).resolves.toBeUndefined();
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
  });
});

describe("PasswordResetService.reset", () => {
  it("sets the new password, burns the token and ends every session", async () => {
    const p = prisma({ user: { id: "u1" } });
    await new PasswordResetService(p, email()).reset("a".repeat(64), "nueva-clave-1");
    const where = p.user.findFirst.mock.calls[0][0].where;
    expect(where.passwordResetToken).toBe(PasswordResetService.hash("a".repeat(64)));
    expect(where.passwordResetExpires.gt).toBeInstanceOf(Date);
    const data = p.user.update.mock.calls[0][0].data;
    expect(await bcrypt.compare("nueva-clave-1", data.passwordHash)).toBe(true);
    expect(data).toMatchObject({
      passwordResetToken: null,
      passwordResetExpires: null,
      tokenVersion: { increment: 1 },
      loginAttempts: 0,
      lockedUntil: null,
    });
  });

  it("works for a client account", async () => {
    const p = prisma({ client: { id: "c1" } });
    await new PasswordResetService(p, email()).reset("b".repeat(64), "nueva-clave-1");
    expect(p.client.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1" }, data: expect.objectContaining({ tokenVersion: { increment: 1 } }) }),
    );
  });

  it("refuses an unknown or expired token, and a short password", async () => {
    const service = new PasswordResetService(prisma(), email());
    await expect(service.reset("c".repeat(64), "nueva-clave-1")).rejects.toMatchObject({ status: 400 });
    await expect(service.reset("short", "nueva-clave-1")).rejects.toMatchObject({ status: 400 });
    await expect(service.reset("d".repeat(64), "corta")).rejects.toMatchObject({ status: 400 });
  });
});

describe("logout", () => {
  function auth(p: any) {
    return new AuthService(p, {} as any, {} as any, {} as any, {} as any);
  }

  it("ends every session of a user", async () => {
    const p = prisma();
    await auth(p).logout("u1", "owner");
    expect(p.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { tokenVersion: { increment: 1 } } });
  });

  it("works for a client, which used to fail", async () => {
    const p = prisma();
    await auth(p).logout("c1", "client");
    expect(p.client.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { tokenVersion: { increment: 1 } } });
    expect(p.user.update).not.toHaveBeenCalled();
  });
});

describe("JwtStrategy", () => {
  const user = { id: "u1", email: "a@b.test", role: "owner", tenantId: "t1", isActive: true, tokenVersion: 2, tenant: {} };
  const strategy = (p: any) => new JwtStrategy({ get: () => "secret-of-sufficient-length-1234567890" } as any, p);

  it("refuses a token from before the last logout or password change", async () => {
    await expect(strategy(prisma({ user })).validate({ sub: "u1", role: "owner", tv: 1 } as any)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("accepts a token with the current session version", async () => {
    await expect(strategy(prisma({ user })).validate({ sub: "u1", role: "owner", tv: 2 } as any)).resolves.toMatchObject({
      id: "u1",
    });
  });

  it("treats tokens minted before tv existed as version 0", async () => {
    const fresh = { ...user, tokenVersion: 0 };
    await expect(strategy(prisma({ user: fresh })).validate({ sub: "u1", role: "owner" } as any)).resolves.toBeTruthy();
  });
});
