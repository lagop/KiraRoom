/**
 * The retention switch set from the console: off by default, two-step
 * sign-in to change it, audited, and the server's RETENTION_ANONYMIZE_ENABLED
 * still turns it on as an override.
 */
import { ForbiddenException } from "@nestjs/common";
import { PlatformRetentionConfigService, retentionEffective } from "./platform-retention-config.service";

function build(opts: { twoFactor?: boolean; env?: Record<string, string>; row?: any } = {}) {
  let row: any = opts.row ?? null;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ twoFactorEnabled: opts.twoFactor ?? true, email: "admin@kiraroom.test" }),
    },
    platformRetentionConfig: {
      findUnique: jest.fn(async () => row),
      upsert: jest.fn(async ({ create, update }: any) => {
        row = row ? { ...row, ...update, updatedAt: new Date() } : { ...create, updatedAt: new Date() };
        return row;
      }),
    },
  };
  const env = opts.env ?? {};
  const config = { get: (key: string) => env[key] };
  const auditLog = { record: jest.fn().mockResolvedValue({ id: "a1" }) };
  const service = new PlatformRetentionConfigService(prisma as any, config as any, auditLog as any);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, prisma, auditLog };
}

const admin = { id: "u1", role: "saas_owner" };

describe("PlatformRetentionConfigService", () => {
  it("is off by default: no row, no env var", async () => {
    const { service } = build();
    expect(await service.isEnabled()).toBe(false);
    expect(await service.getConfig()).toEqual({ enabled: false, envOverride: false, effective: false, updatedAt: null, updatedBy: null });
  });

  it("turning it on and off is stored, applied at once and audited with who and what", async () => {
    const { service, auditLog, prisma } = build();
    const on = await service.update({ enabled: true }, admin);
    expect(on).toMatchObject({ enabled: true, effective: true, updatedBy: "admin@kiraroom.test" });
    expect(await service.isEnabled()).toBe(true);
    expect(prisma.platformRetentionConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "global" }, create: expect.objectContaining({ enabled: true }) }),
    );
    expect(auditLog.record).toHaveBeenCalledWith(
      "platform.retention_config.updated",
      expect.objectContaining({ actorId: "u1", actorRole: "saas_owner", metadata: { enabled: true, previous: false, envOverride: false } }),
    );

    const off = await service.update({ enabled: false }, admin);
    expect(off).toMatchObject({ enabled: false, effective: false });
    expect(await service.isEnabled()).toBe(false);
    expect(auditLog.record).toHaveBeenLastCalledWith(
      "platform.retention_config.updated",
      expect.objectContaining({ metadata: { enabled: false, previous: true, envOverride: false } }),
    );
  });

  it("needs two-step sign-in, and writes nothing without it", async () => {
    const { service, prisma, auditLog } = build({ twoFactor: false });
    await expect(service.update({ enabled: true }, admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.platformRetentionConfig.upsert).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it("RETENTION_ANONYMIZE_ENABLED=true turns it on even with no row, and the console cannot turn it off", async () => {
    const { service } = build({ env: { RETENTION_ANONYMIZE_ENABLED: "true" } });
    expect(await service.isEnabled()).toBe(true);
    expect(await service.getConfig()).toMatchObject({ enabled: false, envOverride: true, effective: true });
    expect(await service.update({ enabled: false }, admin)).toMatchObject({ enabled: false, envOverride: true, effective: true });
    expect(await service.isEnabled()).toBe(true);
  });

  it("any other env value is not an override", async () => {
    for (const v of ["", "1", "false", "yes"]) {
      const { service } = build({ env: { RETENTION_ANONYMIZE_ENABLED: v } });
      expect(await service.isEnabled()).toBe(false);
    }
    expect(retentionEffective("true", false)).toBe(true);
    expect(retentionEffective(undefined, true)).toBe(true);
    expect(retentionEffective("no", false)).toBe(false);
  });
});
