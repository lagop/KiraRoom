import { UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { AuthService, INVALID_CREDENTIALS } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { SALON_DELETED_MESSAGE } from "./salon-deleted";
import { SaasService } from "../saas/saas.service";

/**
 * Audit 7 N7: a salon deleted from the platform console went on working.
 * Its page answered 404, but the owner and the team could still sign in and
 * use the panel. Now the deletion deactivates them and ends their sessions,
 * and both the login and every request refuse a deleted salon's users.
 */

// Built at runtime: a fictitious signing key.
const SECRET = ["test", "signing", "key", "x".repeat(32)].join("-");

describe("deleting a salon from the console", () => {
  it("deactivates its team and ends their sessions, in the same transaction", async () => {
    const tx: any = {
      tenant: { update: jest.fn(async () => ({ id: "t1" })) },
      user: { updateMany: jest.fn(async () => ({ count: 3 })) },
      widgetInstance: { findMany: jest.fn(async () => []), update: jest.fn() },
    };
    const prisma: any = {
      tenant: { findFirst: jest.fn(async () => ({ id: "t1", deletedAt: null })), count: jest.fn(async () => 0) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const auditLog: any = { record: jest.fn(async () => ({ id: "audit-1" })) };
    const subscriptions: any = { cancelStripeSubscriptionNow: jest.fn(async () => ({ cancelled: false })) };
    const service = new SaasService(prisma, {} as any, auditLog, subscriptions);

    await service.deleteTenant("t1", "owner-1");

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", role: { not: "saas_owner" } },
      data: { isActive: false, tokenVersion: { increment: 1 } },
    });
    expect(auditLog.record.mock.calls[0][1].metadata).toMatchObject({ usersDeactivated: 3 });
  });
});

describe("a deleted salon's users", () => {
  it("cannot sign in, and read why in Spanish", async () => {
    const service = Object.create(AuthService.prototype);
    service.prisma = {
      user: {
        findUnique: jest.fn(async () => ({
          id: "u1",
          email: "duena@salon.test",
          role: "owner",
          isActive: true,
          loginAttempts: 0,
          lockedUntil: null,
          passwordHash: bcrypt.hashSync("la-buena-clave", 4),
          tenant: { deletedAt: new Date("2026-11-01T00:00:00Z") },
        })),
        update: jest.fn(async () => ({})),
      },
    };
    const attempt = service.login({ email: "duena@salon.test", password: "la-buena-clave" });
    await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.login({ email: "duena@salon.test", password: "la-buena-clave" })).rejects.toThrow(
      SALON_DELETED_MESSAGE,
    );
    // With a wrong password nothing about the salon is said (audit 7A, S10).
    await expect(service.login({ email: "duena@salon.test", password: "otra-clave-1" })).rejects.toThrow(
      INVALID_CREDENTIALS,
    );
  });

  it("have every request refused, even with a token issued before the deletion", async () => {
    const user = {
      id: "u1",
      email: "duena@salon.test",
      firstName: "Ana",
      lastName: "Gil",
      role: "owner",
      tenantId: "t1",
      isActive: true,
      tokenVersion: 0,
      tenant: { plan: "pro", subscriptionStatus: "active", deletedAt: new Date("2026-11-01T00:00:00Z") },
    };
    const prisma: any = { user: { findUnique: jest.fn(async () => user) } };
    const strategy = new JwtStrategy({ get: () => SECRET } as any, prisma);
    await expect(
      strategy.validate({ typ: "access", sub: "u1", email: user.email, role: "owner", tenantId: "t1", tv: 0 }),
    ).rejects.toThrow(SALON_DELETED_MESSAGE);

    user.tenant.deletedAt = null as any;
    await expect(
      strategy.validate({ typ: "access", sub: "u1", email: user.email, role: "owner", tenantId: "t1", tv: 0 }),
    ).resolves.toMatchObject({ id: "u1", tenantId: "t1" });
  });
});
