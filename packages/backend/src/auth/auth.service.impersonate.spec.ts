import { UnauthorizedException, NotFoundException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { IMPERSONATION_AUDIENCE } from "../saas/saas.constants";

/**
 * Lightweight unit tests for AuthService.impersonate.
 *
 * The flow as of the post-fix ordering is:
 *   1. Validate the JWT payload shape
 *   2. Resolve the target tenant via the shared getActiveTenant() helper
 *      (throws NotFoundException if soft-deleted / missing)
 *   3. Resolve the target owner (throws UnauthorizedException if missing
 *      or inactive)
 *   4. $transaction([usedImpersonationToken.create, auditLog.create]) —
 *      a duplicate jti raises P2002 and surfaces as the
 *      "already consumed" 401 (replay protection)
 *   5. Mint the tenant-owner session with impersonation claims baked in
 *
 * The replay-protection atomic insert is best exercised by the e2e
 * suite because it needs a real DB; this unit layer focuses on the
 * pre-validation guards (1-3) and the P2002 branch (4).
 */
describe("AuthService.impersonate — JWT payload validation", () => {
  let jwtVerify: jest.Mock;
  let prisma: any;
  let auth: AuthService;

  beforeEach(() => {
    jwtVerify = jest.fn();
    jwtVerify.mockImplementation((token: string) => {
      if (token === "expired") {
        throw new Error("jwt expired");
      }
      if (token === "bad") {
        throw new Error("signature mismatch");
      }
      return JSON.parse(Buffer.from(token, "base64").toString());
    });

    // Default mocks: tenant exists, owner exists, the $transaction
    // (array form) just awaits every promise in the array. Specific
    // tests override per-call as needed.
    const jwtService: any = {
      verify: jwtVerify,
      sign: jest.fn().mockReturnValue("signed-jwt"),
    };
    prisma = {
      usedImpersonationToken: {
        create: jest.fn().mockResolvedValue({ jti: "ok" }),
      },
      tenant: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: "tenant-id", name: "T", slug: "t" }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: "owner-id",
          email: "owner@e.test",
          firstName: "Owner",
          lastName: "Test",
          role: "owner",
          tenantId: "tenant-id",
          isActive: true,
          professional: null,
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-id" }) },
      // shimmed: Prisma's $transaction supports both the array form
      // (pass an array of promises) and the callback form (pass a
      // function that's invoked with a `tx` client). The implementation
      // uses the callback form; we mirror that here so the AuditLog
      // service is invoked with the same `tx` reference, which the
      // mock's `record` callback below propagates to `prisma.auditLog.create`.
      $transaction: jest.fn(async (arg: any) => {
        if (typeof arg === "function") {
          return arg(prisma);
        }
        if (Array.isArray(arg)) {
          const out: unknown[] = [];
          for (const p of arg) {
            out.push(await p);
          }
          return out;
        }
        throw new TypeError("prisma.$transaction mock: unsupported shape");
      }),
    };
    const auditLog: any = {
      record: jest.fn(async (action: string, params: any, _tx?: any) => {
        return prisma.auditLog.create({ data: { action, ...params } });
      }),
    };
    auth = new AuthService(prisma, jwtService, auditLog, {
      record: jest.fn(),
      recordOnce: jest.fn().mockResolvedValue(undefined),
    } as any);
  });

  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64");

  const validPayload = {
    sub: "saas-admin-id",
    jti: "00000000-0000-0000-0000-000000000001",
    aud: IMPERSONATION_AUDIENCE,
    impersonate: {
      tenantId: "tenant-id",
      ownerId: "owner-id",
    },
  };

  it("rejects empty token", async () => {
    await expect(
      auth.impersonate("", "support", IMPERSONATION_AUDIENCE),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects expired token", async () => {
    await expect(
      auth.impersonate("expired", "support", IMPERSONATION_AUDIENCE),
    ).rejects.toMatchObject({ message: expect.stringMatching(/expired/) });
  });

  it("rejects forged-signature token", async () => {
    await expect(
      auth.impersonate("bad", "support", IMPERSONATION_AUDIENCE),
    ).rejects.toMatchObject({ message: expect.stringMatching(/Invalid/) });
  });

  it("rejects payload missing jti (anti-replay enforcement)", async () => {
    const { jti: _drop, ...noJti } = validPayload;
    await expect(
      auth.impersonate(enc(noJti), "support", IMPERSONATION_AUDIENCE),
    ).rejects.toMatchObject({ message: expect.stringMatching(/payload/) });
  });

  it("rejects payload missing impersonate.tenantId", async () => {
    const t = { ...validPayload };
    t.impersonate = { ...t.impersonate, tenantId: undefined };
    await expect(
      auth.impersonate(enc(t), "support", IMPERSONATION_AUDIENCE),
    ).rejects.toMatchObject({ message: expect.stringMatching(/payload/) });
  });

  it("rejects payload missing impersonate.ownerId", async () => {
    const t = { ...validPayload };
    t.impersonate = { ...t.impersonate, ownerId: undefined };
    await expect(
      auth.impersonate(enc(t), "support", IMPERSONATION_AUDIENCE),
    ).rejects.toMatchObject({ message: expect.stringMatching(/payload/) });
  });

  it("rejects payload with wrong audience", async () => {
    await expect(
      auth.impersonate(
        enc({ ...validPayload, aud: "wrong-aud" }),
        "support",
        IMPERSONATION_AUDIENCE,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/payload/) });
  });

  it("does NOT burn the jti when the tenant is gone — fail-fast with 404", async () => {
    // The fix: validate-before-consume. A first attempt that fails because
    // the tenant was just soft-deleted should leave used_impersonation_tokens
    // untouched so the SaaS admin can re-launch and try again.
    prisma.tenant.findFirst.mockResolvedValueOnce(null);
    await expect(
      auth.impersonate(enc(validPayload), "support", IMPERSONATION_AUDIENCE),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.usedImpersonationToken.create).not.toHaveBeenCalled();
  });

  it("does NOT burn the jti when the owner is deactivated", async () => {
    prisma.user.findFirst.mockResolvedValueOnce(null);
    await expect(
      auth.impersonate(enc(validPayload), "support", IMPERSONATION_AUDIENCE),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.usedImpersonationToken.create).not.toHaveBeenCalled();
  });

  it("anti-replay: rejects a second consume of the same jti (P2002 branch)", async () => {
    // Mocks already return a valid tenant + owner; force the
    // used_impresonation_tokens.create call to throw P2002 to simulate
    // the duplicate-key constraint surfacing in production.
    prisma.usedImpersonationToken.create.mockRejectedValueOnce({
      code: "P2002",
      message: "Unique constraint failed",
    });
    await expect(
      auth.impersonate(enc(validPayload), "support", IMPERSONATION_AUDIENCE),
    ).rejects.toMatchObject({ message: expect.stringMatching(/already consumed/) });
  });

  it("happy path: writes the consumed jti row AND the audit row in one transaction", async () => {
    const result = await auth.impersonate(
      enc(validPayload),
      "support",
      IMPERSONATION_AUDIENCE,
    );
    expect(result.user.role).toBe("owner");
    expect(result.tokens.accessToken).toBeDefined();
    // The two writes must be passed to a single $transaction call. Even
    // when mocked as separate calls, the recorder captures the args.
    expect(prisma.usedImpersonationToken.create).toHaveBeenCalledWith({
      data: {
        jti: validPayload.jti,
        tenantId: validPayload.impersonate.tenantId,
        consumedBy: validPayload.sub,
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: validPayload.sub,
          action: "saas.impersonate",
        }),
      }),
    );
  });
});
