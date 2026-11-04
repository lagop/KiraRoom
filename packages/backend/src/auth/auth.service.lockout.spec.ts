import { UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { AuthService, INVALID_CREDENTIALS } from "./auth.service";

/**
 * SEC-8: the failed-login lockout was written and never read.
 *
 * `login()` has always incremented `loginAttempts` and, on the fifth
 * failure, stamped `lockedUntil` 30 minutes into the future. Nothing ever
 * looked at that column again, so the lockout was decorative: it filled up
 * while `bcrypt.compare` kept answering every subsequent guess. The only
 * real limit was the global throttle -- 100 requests per minute -- against
 * an admin address an attacker can guess.
 *
 * Found while diagnosing a production login failure: the single `saas_owner`
 * account showed `loginAttempts = 3` and `lockedUntil = null`, which is what
 * prompted reading the column's only two usages. Both were writes.
 */

const HASH = bcrypt.hashSync("correct-horse-battery", 4);

function buildAuth(user: Record<string, unknown> | null): {
  auth: AuthService;
  prisma: any;
} {
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    client: { findUnique: jest.fn().mockResolvedValue(null) },
    tenant: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg),
    ),
  };
  const jwtService: any = {
    sign: jest.fn().mockReturnValue("signed-jwt"),
    verify: jest.fn(),
  };
  const auth = new AuthService(
    prisma,
    jwtService,
    { record: jest.fn() } as any,
    { record: jest.fn(), recordOnce: jest.fn().mockResolvedValue(undefined) } as any,
    {
      sendWelcome: jest.fn().mockResolvedValue({ success: true }),
      sendEmailVerification: jest.fn().mockResolvedValue({ success: true }),
    } as any,
    { start: jest.fn(async () => ({ sid: "sid-1", jti: "jti-1" })), rotate: jest.fn() } as any,
    {} as any,
  );
  return { auth, prisma };
}

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "owner@salon.test",
    firstName: "O",
    lastName: "T",
    role: "saas_owner",
    tenantId: "tenant-1",
    isActive: true,
    passwordHash: HASH,
    loginAttempts: 0,
    lockedUntil: null,
    professional: null,
    ...overrides,
  };
}

describe("SEC-8: AuthService.login honours lockedUntil", () => {
  it("refuses a locked account even with the CORRECT password", async () => {
    // The whole point. Before this, a locked account accepted the password
    // and signed in, so the lockout stopped nobody -- least of all someone
    // who had just guessed it.
    const { auth, prisma } = buildAuth(
      activeUser({
        loginAttempts: 5,
        lockedUntil: new Date(Date.now() + 20 * 60 * 1000),
      }),
    );

    await expect(
      auth.login({ email: "owner@salon.test", password: "correct-horse-battery" }),
    ).rejects.toThrow(UnauthorizedException);

    // And it must not have been treated as a failed attempt either: a
    // locked-out caller should not be able to extend their own lock.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("says how long is left, so the user is not left guessing", async () => {
    const { auth } = buildAuth(
      activeUser({ lockedUntil: new Date(Date.now() + 9.5 * 60 * 1000) }),
    );

    await expect(
      auth.login({ email: "owner@salon.test", password: "correct-horse-battery" }),
    ).rejects.toThrow(/Vuelve a intentarlo en 10 minutos/);
  });

  it("uses the singular for the last minute", async () => {
    const { auth } = buildAuth(
      activeUser({ lockedUntil: new Date(Date.now() + 30 * 1000) }),
    );

    await expect(
      auth.login({ email: "owner@salon.test", password: "correct-horse-battery" }),
    ).rejects.toThrow(/Vuelve a intentarlo en 1 minuto\./);
  });

  it("S10: with a wrong password a locked account answers like any wrong password", async () => {
    // Saying "locked" before checking the password told a stranger the
    // account exists. Now only the right password learns about the lock.
    const { auth, prisma } = buildAuth(
      activeUser({ loginAttempts: 5, lockedUntil: new Date(Date.now() + 20 * 60 * 1000) }),
    );

    await expect(
      auth.login({ email: "owner@salon.test", password: "wrong-password" }),
    ).rejects.toThrow(INVALID_CREDENTIALS);
    // ...and does not extend the lock.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("S10: a deactivated account with a wrong password says nothing about being deactivated", async () => {
    const { auth } = buildAuth(activeUser({ isActive: false }));

    await expect(
      auth.login({ email: "owner@salon.test", password: "wrong-password" }),
    ).rejects.toThrow(INVALID_CREDENTIALS);
  });

  it("S10: once the lock has run out the count starts again", async () => {
    // loginAttempts stayed at 5 after the 30 minutes, so the first slip
    // after the lock locked the account straight away.
    const { auth, prisma } = buildAuth(
      activeUser({ loginAttempts: 5, lockedUntil: new Date(Date.now() - 60 * 1000) }),
    );

    await expect(
      auth.login({ email: "owner@salon.test", password: "wrong-password" }),
    ).rejects.toThrow(INVALID_CREDENTIALS);

    const written = prisma.user.update.mock.calls[0][0].data;
    expect(written.loginAttempts).toBe(1);
    expect(written.lockedUntil).toBeNull();
  });

  it("S4: an address typed with capitals finds the account", async () => {
    const { auth, prisma } = buildAuth(activeUser());

    await auth.login({ email: "  Owner@Salon.TEST ", password: "correct-horse-battery" });

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "owner@salon.test" } }),
    );
  });

  it("S4: a row the migration left with capitals is still found, ignoring case", async () => {
    const { auth, prisma } = buildAuth(null);
    prisma.user.findMany = jest.fn().mockResolvedValue([activeUser({ email: "Owner@Salon.test" })]);

    const result = await auth.login({ email: "owner@salon.test", password: "correct-horse-battery" });

    expect((result as any).user.email).toBe("Owner@Salon.test");
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      email: { equals: "owner@salon.test", mode: "insensitive" },
    });
  });

  it("S4: with two such rows the password decides which account it is", async () => {
    const { auth, prisma } = buildAuth(null);
    const other = activeUser({ id: "user-2", email: "OWNER@salon.test", passwordHash: bcrypt.hashSync("another-one-1", 4) });
    prisma.user.findMany = jest.fn().mockResolvedValue([other, activeUser({ email: "Owner@Salon.test" })]);

    const result = await auth.login({ email: "owner@salon.test", password: "correct-horse-battery" });

    expect((result as any).user.id).toBe("user-1");
  });

  it("an unknown address gets the same answer as a wrong password", async () => {
    const { auth, prisma } = buildAuth(null);
    prisma.user.findMany = jest.fn().mockResolvedValue([]);

    await expect(
      auth.login({ email: "nobody@salon.test", password: "whatever-1" }),
    ).rejects.toThrow(INVALID_CREDENTIALS);
  });

  it("lets an expired lock through", async () => {
    // A lock is a delay, not a ban. Once it passes, the correct password
    // works again without an admin unlocking anything.
    const { auth } = buildAuth(
      activeUser({
        loginAttempts: 5,
        lockedUntil: new Date(Date.now() - 60 * 1000),
      }),
    );

    const result = await auth.login({
      email: "owner@salon.test",
      password: "correct-horse-battery",
    });

    expect((result as any).user.email).toBe("owner@salon.test");
  });

  it("is unaffected when lockedUntil is null", async () => {
    const { auth } = buildAuth(activeUser());

    const result = await auth.login({
      email: "owner@salon.test",
      password: "correct-horse-battery",
    });

    expect((result as any).user.role).toBe("saas_owner");
  });

  it("still rejects a wrong password on an unlocked account", async () => {
    const { auth, prisma } = buildAuth(activeUser({ loginAttempts: 1 }));

    await expect(
      auth.login({ email: "owner@salon.test", password: "wrong" }),
    ).rejects.toThrow(UnauthorizedException);

    // The attempt counter still moves, which is what eventually locks it.
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it("locks on the fifth consecutive failure", async () => {
    // loginAttempts is the count BEFORE this attempt, so 4 means this is
    // the fifth.
    const { auth, prisma } = buildAuth(activeUser({ loginAttempts: 4 }));

    await expect(
      auth.login({ email: "owner@salon.test", password: "wrong" }),
    ).rejects.toThrow(UnauthorizedException);

    const written = prisma.user.update.mock.calls[0][0].data;
    expect(written.lockedUntil).toBeInstanceOf(Date);
    expect(written.lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not lock before the threshold", async () => {
    const { auth, prisma } = buildAuth(activeUser({ loginAttempts: 1 }));

    await expect(
      auth.login({ email: "owner@salon.test", password: "wrong" }),
    ).rejects.toThrow(UnauthorizedException);

    expect(prisma.user.update.mock.calls[0][0].data.lockedUntil).toBeNull();
  });

  it("checks deactivation before the lock, so the clearer reason wins", async () => {
    const { auth } = buildAuth(
      activeUser({
        isActive: false,
        lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
      }),
    );

    await expect(
      auth.login({ email: "owner@salon.test", password: "correct-horse-battery" }),
    ).rejects.toThrow(/desactivada/);
  });
});
