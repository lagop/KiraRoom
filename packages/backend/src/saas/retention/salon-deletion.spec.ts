import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { SalonDeletionService } from "./salon-deletion.service";
import { DAY_MS } from "./salon-retention";

/**
 * "Borrar mi salón" (audit 7 D7): the owner's password (and 2FA code), then
 * read-only now and anonymised 30 days after; nothing more is charged; and
 * it can be undone while it is pending.
 */

// Built at runtime: a fictitious password.
const PASSWORD = ["clave", "de", "prueba", "2026"].join("-");
const NOW = new Date("2026-11-04T10:00:00.000Z");

async function harness(tenant: Record<string, any>, user: Record<string, any> = {}) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const row: any = {
    id: "t1",
    name: "Salón Luna",
    subscriptionStatus: "active",
    stripeSubscriptionId: "sub_1",
    subscriptionCancelAt: null,
    readOnlyUntil: null,
    cancelledAt: null,
    trialEnd: null,
    deletedAt: null,
    anonymizedAt: null,
    deletionRequestedAt: null,
    deletionRestore: null,
    ...tenant,
  };
  const u = { id: "u1", passwordHash: hash, twoFactorEnabled: false, ...user };
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({ ...row })),
      update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
    },
    user: {
      findFirst: jest.fn(async ({ where }: any) => (where.role === "owner" ? { email: "duena@salon.test" } : u)),
      findUnique: jest.fn(async () => u),
    },
  };
  const subscriptions = {
    cancelSubscription: jest.fn(async () => {
      if (row.stripeSubscriptionId && row.subscriptionStatus === "active") row.subscriptionCancelAt = new Date(NOW.getTime() + 20 * DAY_MS);
      else Object.assign(row, { subscriptionStatus: "cancelled" });
      return {};
    }),
    undoCancellation: jest.fn(async () => {
      row.subscriptionCancelAt = null;
      return {};
    }),
  };
  const twoFactor = { verifyForLogin: jest.fn(async (_u: string, code: string) => code === "123456") };
  const email = { sendAccountReadOnly: jest.fn(async () => ({ success: true })) };
  const auditLog = { record: jest.fn(async () => ({ id: "a1" })) };
  const config = { get: () => undefined };
  const service = new SalonDeletionService(prisma, subscriptions as any, twoFactor as any, email as any, config as any, auditLog as any);
  return { service, row, prisma, subscriptions, twoFactor, email, auditLog };
}

const owner = { id: "u1", role: "owner" };

describe("asking to delete the salon", () => {
  it("only the owner, and only with her password", async () => {
    const t = await harness({});
    await expect(t.service.request("t1", { id: "u2", role: "admin" }, { password: PASSWORD }, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(t.service.request("t1", owner, { password: "otra" }, NOW)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.prisma.tenant.update).not.toHaveBeenCalled();
    expect(t.subscriptions.cancelSubscription).not.toHaveBeenCalled();
  });

  it("with two-step verification on, the code too", async () => {
    const t = await harness({}, { twoFactorEnabled: true });
    await expect(t.service.request("t1", owner, { password: PASSWORD }, NOW)).rejects.toThrow(/código/);
    await expect(t.service.request("t1", owner, { password: PASSWORD, code: "000000" }, NOW)).rejects.toThrow(/no es correcto/);
    expect(t.prisma.tenant.update).not.toHaveBeenCalled();
    await t.service.request("t1", owner, { password: PASSWORD, code: "123456" }, NOW);
    expect(t.row.deletionRequestedAt).toEqual(NOW);
  });

  it("a paying salon: the subscription ends with its period, the salon is read-only now and anonymised 60 days on", async () => {
    const t = await harness({});
    const status = await t.service.request("t1", owner, { password: PASSWORD }, NOW);
    expect(t.subscriptions.cancelSubscription).toHaveBeenCalledWith("t1");
    expect(t.row).toMatchObject({ subscriptionStatus: "cancelled", deletionRequestedAt: NOW });
    expect(t.row.readOnlyUntil).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
    expect(t.row.deletionRestore).toMatchObject({ status: "active", stripeScheduled: true });
    expect(status).toMatchObject({
      pending: true,
      exportUntil: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
      anonymizeOn: new Date(NOW.getTime() + 60 * DAY_MS).toISOString(),
    });
    expect(t.email.sendAccountReadOnly).toHaveBeenCalledWith(expect.objectContaining({ reason: "deletion_requested" }));
    expect(t.auditLog.record).toHaveBeenCalledWith("tenant.deletion_requested", expect.anything());
  });

  it("twice: refused, the first request stands", async () => {
    const t = await harness({ deletionRequestedAt: NOW, subscriptionStatus: "cancelled" });
    await expect(t.service.request("t1", owner, { password: PASSWORD }, NOW)).rejects.toBeInstanceOf(ConflictException);
  });

  it("an already read-only salon: no billing call, its data goes 60 days from now", async () => {
    const t = await harness({ subscriptionStatus: "cancelled", stripeSubscriptionId: null, readOnlyUntil: new Date(NOW.getTime() + 5 * DAY_MS) });
    await t.service.request("t1", owner, { password: PASSWORD }, NOW);
    expect(t.subscriptions.cancelSubscription).not.toHaveBeenCalled();
    expect(t.row.readOnlyUntil).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
  });
});

describe("cancelling the deletion", () => {
  it("a paying salon renews again and is as before", async () => {
    const t = await harness({});
    await t.service.request("t1", owner, { password: PASSWORD }, NOW);
    const status = await t.service.cancel("t1", owner, new Date(NOW.getTime() + DAY_MS));
    expect(t.subscriptions.undoCancellation).toHaveBeenCalledWith("t1");
    expect(t.row).toMatchObject({ subscriptionStatus: "active", readOnlyUntil: null, deletionRequestedAt: null, deletionRestore: null });
    expect(status.pending).toBe(false);
  });

  it("if Stripe cannot renew it, the salon stays read-only (as after any cancellation)", async () => {
    const t = await harness({});
    await t.service.request("t1", owner, { password: PASSWORD }, NOW);
    t.subscriptions.undoCancellation.mockRejectedValueOnce(new Error("ended"));
    await t.service.cancel("t1", owner, new Date(NOW.getTime() + DAY_MS));
    expect(t.row).toMatchObject({ subscriptionStatus: "cancelled", deletionRequestedAt: null });
    expect(t.row.readOnlyUntil).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
  });

  it("a trial still running goes back to the trial", async () => {
    const t = await harness({ subscriptionStatus: "trialing", stripeSubscriptionId: null, trialEnd: new Date(NOW.getTime() + 5 * DAY_MS) });
    await t.service.request("t1", owner, { password: PASSWORD }, NOW);
    await t.service.cancel("t1", owner, new Date(NOW.getTime() + DAY_MS));
    expect(t.row).toMatchObject({ subscriptionStatus: "trialing", readOnlyUntil: null, deletionRequestedAt: null });
  });

  it("nothing pending: refused", async () => {
    const t = await harness({});
    await expect(t.service.cancel("t1", owner, NOW)).rejects.toBeInstanceOf(ConflictException);
  });
});
