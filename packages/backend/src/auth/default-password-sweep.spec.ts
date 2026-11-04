import * as bcrypt from "bcryptjs";
import {
  DEFAULT_PASSWORD_SWEEP_TASK,
  DefaultPasswordSweepService,
  SWEEP_BATCH_SIZE,
  oldConsoleDefaultPassword,
} from "./default-password-sweep.service";

function makeSweep(users: Array<{ id: string; email: string; tenantId: string | null; passwordHash: string }>) {
  const tasks = new Map<string, any>();
  const updates: any[] = [];
  const prisma: any = {
    maintenanceTask: {
      findUnique: jest.fn(async ({ where }: any) => tasks.get(where.name) ?? null),
      create: jest.fn(async ({ data }: any) => tasks.set(data.name, data)),
    },
    user: {
      findMany: jest.fn(async (args: any) => {
        const sorted = [...users].sort((a, b) => a.id.localeCompare(b.id));
        const start = args.cursor ? sorted.findIndex((u) => u.id === args.cursor.id) + (args.skip ?? 0) : 0;
        return sorted.slice(start, start + args.take);
      }),
      update: jest.fn(async (args: any) => {
        updates.push(args);
        const u = users.find((x) => x.id === args.where.id)!;
        u.passwordHash = args.data.passwordHash;
      }),
    },
  };
  const passwordReset = { request: jest.fn(async () => undefined) };
  const auditLog = { record: jest.fn(async () => ({ id: "a" })) };
  const sweep = new DefaultPasswordSweepService(prisma, passwordReset as any, auditLog as any);
  return { sweep, prisma, passwordReset, auditLog, updates, tasks };
}

describe("DefaultPasswordSweepService", () => {
  // Low cost so the spec is quick; the service compares whatever cost is stored.
  const hash = (plain: string) => bcrypt.hashSync(plain, 4);
  const otherPassword = ["otra", "clave", "segura"].join("-");

  it("resets only the users still on the old default, and records the marker", async () => {
    const users = [
      { id: "u1", email: "a@salon.test", tenantId: "t1", passwordHash: hash(oldConsoleDefaultPassword()) },
      { id: "u2", email: "b@salon.test", tenantId: "t2", passwordHash: hash(otherPassword) },
      { id: "u3", email: "c@salon.test", tenantId: null, passwordHash: "not-a-bcrypt-hash" },
    ];
    const { sweep, passwordReset, auditLog, updates, tasks } = makeSweep(users);
    const result = await sweep.run();
    expect(result).toEqual({ checked: 3, reset: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ id: "u1" });
    expect(updates[0].data.tokenVersion).toEqual({ increment: 1 });
    expect(await bcrypt.compare(oldConsoleDefaultPassword(), users[0].passwordHash)).toBe(false);
    expect(passwordReset.request).toHaveBeenCalledWith("a@salon.test");
    expect(auditLog.record).toHaveBeenCalledWith(
      "user.default_password.reset",
      expect.objectContaining({ tenantId: "t1", metadata: { userId: "u1" } }),
    );
    expect(tasks.get(DEFAULT_PASSWORD_SWEEP_TASK).result).toEqual({ checked: 3, reset: 1 });
  });

  it("runs once: with the marker present it does nothing", async () => {
    const { sweep, prisma } = makeSweep([]);
    await sweep.run();
    expect(await sweep.run()).toBeNull();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  it("goes through the users in batches", async () => {
    const users = Array.from({ length: SWEEP_BATCH_SIZE + 3 }, (_, i) => ({
      id: `u${String(i).padStart(3, "0")}`,
      email: `${i}@salon.test`,
      tenantId: "t1",
      passwordHash: "x",
    }));
    const { sweep, prisma } = makeSweep(users);
    expect(await sweep.run()).toEqual({ checked: SWEEP_BATCH_SIZE + 3, reset: 0 });
    expect(prisma.user.findMany).toHaveBeenCalledTimes(3);
  });

  it("does not start during boot in tests", () => {
    const { sweep, prisma } = makeSweep([]);
    sweep.onApplicationBootstrap();
    expect(prisma.maintenanceTask.findUnique).not.toHaveBeenCalled();
  });
});
