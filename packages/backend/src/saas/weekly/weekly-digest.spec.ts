import { Prisma } from "@prisma/client";
import { consoleWeek, isoWeek, renderWeeklyDigestEmail, WeeklyDigestService } from "./weekly-digest.service";
import { WeeklyDigestScheduler, weeklyDigestTask } from "./weekly-digest.scheduler";
import { DAY_MS } from "../retention/salon-retention";

const NOW = new Date("2026-11-09T07:00:00Z"); // Monday 08:00 in Madrid
const days = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

const retention = (on = false) => ({ isEnabled: jest.fn(async () => on) }) as any;

function fakePrisma() {
  const tenantFindMany = jest.fn(async (args: any) => {
    const w = args.where;
    if (w.subscriptionStatus === "past_due")
      return [{ id: "t-pd", name: "Pago <fallido>", paymentFailedAt: days(-3), gracePeriodEndsAt: days(4) }];
    if (w.subscriptionStatus === "trialing")
      return [{ id: "t-tr", name: "Prueba", trialEnd: days(2), stripeSubscriptionId: null }];
    if (w.deletionRequestedAt) return [{ id: "t-del", name: "Borrar", deletionRequestedAt: days(-1) }];
    if (w.readOnlyUntil)
      return [
        // anonymised in 5 days: warned tonight
        { id: "t-r1", name: "Ret 1", subscriptionStatus: "cancelled", readOnlyUntil: days(5 - 30), anonymizationWarnedAt: null, anonymizationWarnedFor: null },
        // anonymised in 12 days: warned within the week
        { id: "t-r2", name: "Ret 2", subscriptionStatus: "cancelled", readOnlyUntil: days(12 - 30), anonymizationWarnedAt: null, anonymizationWarnedFor: null },
        // anonymised in 40 days: nothing this week
        { id: "t-r3", name: "Ret 3", subscriptionStatus: "cancelled", readOnlyUntil: days(40 - 30), anonymizationWarnedAt: null, anonymizationWarnedFor: null },
      ];
    if (w.createdAt) return [{ id: "t-ob", name: "Arranque", createdAt: days(-10) }];
    if (w.id) return [{ id: "t-ai", name: "Con IA" }].filter((t) => w.id.in.includes(t.id));
    return [];
  });
  const usage = (tenantId: string, provider: string, model: string, calls: number, input: number, output: number) => ({
    tenantId,
    provider,
    model,
    calls,
    inputTokens: BigInt(input),
    cachedInputTokens: BigInt(0),
    cacheWriteTokens: BigInt(0),
    outputTokens: BigInt(output),
  });
  return {
    tenant: { findMany: tenantFindMany },
    tenantLlmUsage: {
      findMany: jest.fn(async () => [
        usage("t-ai", "anthropic", "claude-haiku-4-5", 10, 1_000_000, 100_000),
        usage("t-ai", "minimax", "no-such-model", 2, 10, 5),
        // a salon that does not count (deleted or internal)
        usage("t-internal", "anthropic", "claude-haiku-4-5", 99, 9_000_000, 0),
      ]),
    },
    bugReport: {
      count: jest.fn(async () => 4),
      findMany: jest.fn(async () => [
        { id: "b1", subject: "No <carga>", status: "open", createdAt: days(-1), tenant: { name: "Salón X" } },
      ]),
    },
  } as any;
}

describe("isoWeek / consoleWeek", () => {
  it("numbers ISO weeks, including the turn of the year", () => {
    expect(isoWeek("2026-11-09")).toBe("2026-W46");
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(isoWeek("2024-12-30")).toBe("2025-W01");
  });

  it("uses the Madrid calendar (Sunday 23:30 UTC is already Monday there)", () => {
    expect(consoleWeek(new Date("2026-11-08T23:30:00Z"))).toBe("2026-W46");
    expect(consoleWeek(new Date("2026-11-08T22:30:00Z"))).toBe("2026-W45");
  });
});

describe("WeeklyDigestService.build (audit 8 D12)", () => {
  it("gathers every block", async () => {
    const d = await new WeeklyDigestService(fakePrisma(), retention()).build(NOW);
    expect(d.week).toBe("2026-W46");
    expect(d.pastDue.map((t) => t.id)).toEqual(["t-pd"]);
    expect(d.trialsEnding).toEqual([{ id: "t-tr", name: "Prueba", trialEnd: days(2).toISOString(), hasSubscription: false }]);
    expect(d.deletionRequests.map((t) => t.id)).toEqual(["t-del"]);
    expect(d.onboardingStuck).toEqual([{ id: "t-ob", name: "Arranque", createdAt: days(-10).toISOString(), days: 10 }]);
    expect(d.openBugReports.count).toBe(4);
    expect(d.openBugReports.latest[0].tenantName).toBe("Salón X");
  });

  it("retention.enabled follows the platform switch", async () => {
    expect((await new WeeklyDigestService(fakePrisma(), retention(false)).build(NOW)).retention.enabled).toBe(false);
    expect((await new WeeklyDigestService(fakePrisma(), retention(true)).build(NOW)).retention.enabled).toBe(true);
  });

  it("retention: tonight's run and what comes due within the week, from the SalonRetention rules", async () => {
    const d = await new WeeklyDigestService(fakePrisma(), retention()).build(NOW);
    expect(d.retention.items.map((r) => [r.id, r.kind, r.dueNow])).toEqual([
      ["t-r1", "warn", true],
      ["t-r2", "warn", false],
    ]);
  });

  it("AI spend: this month, counted salons only, unknown models listed apart", async () => {
    const prisma = fakePrisma();
    const d = await new WeeklyDigestService(prisma, retention()).build(NOW);
    expect(prisma.tenantLlmUsage.findMany).toHaveBeenCalledWith({ where: { period: "2026-11" } });
    expect(d.aiSpend.salons.map((s) => [s.id, s.calls])).toEqual([["t-ai", 12]]);
    expect(d.aiSpend.salons[0].usd).toBeGreaterThan(0);
    expect(d.aiSpend.totalUsd).toBe(d.aiSpend.salons[0].usd);
    expect(d.aiSpend.unpricedModels).toEqual(["minimax/no-such-model"]);
  });

  it("the email escapes what comes from the database", async () => {
    const d = await new WeeklyDigestService(fakePrisma(), retention()).build(NOW);
    const mail = renderWeeklyDigestEmail(d);
    expect(mail.html).toContain("Pago &lt;fallido&gt;");
    expect(mail.html).toContain("No &lt;carga&gt;");
    expect(mail.html).not.toContain("<fallido>");
    expect(mail.subject).toContain("2026-W46");
    expect(mail.text).toContain("Pago <fallido>");
  });
});

describe("WeeklyDigestScheduler", () => {
  function build(sendOk = true) {
    const tasks = new Set<string>();
    const prisma: any = {
      maintenanceTask: {
        create: jest.fn(async ({ data }: any) => {
          if (tasks.has(data.name)) {
            throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
          }
          tasks.add(data.name);
        }),
        update: jest.fn(async () => undefined),
        delete: jest.fn(async ({ where }: any) => tasks.delete(where.name)),
      },
    };
    const digest = { build: jest.fn(async (now: Date) => new WeeklyDigestService(fakePrisma(), retention()).build(now)) };
    const email = { sendEmail: jest.fn(async (_opts: any) => (sendOk ? { success: true } : { success: false, error: "down" })) };
    return { scheduler: new WeeklyDigestScheduler(prisma, digest as any, email as any), tasks, email };
  }

  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("sends once per week to OPS_ALERT_EMAIL, however many times it runs", async () => {
    process.env.OPS_ALERT_EMAIL = "ops@example.test";
    const { scheduler, email, tasks } = build();
    await expect(scheduler.sendWeek(NOW)).resolves.toBe(true);
    await expect(scheduler.sendWeek(new Date(NOW.getTime() + 3600_000))).resolves.toBe(false);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0][0]).toMatchObject({ to: "ops@example.test", idempotencyKey: weeklyDigestTask("2026-W46") });
    expect([...tasks]).toEqual(["weekly-digest:2026-W46"]);
  });

  it("falls back to admin@kiraroom.net", async () => {
    delete process.env.OPS_ALERT_EMAIL;
    delete process.env.FOUNDER_EMAIL;
    const { scheduler, email } = build();
    await scheduler.sendWeek(NOW);
    expect(email.sendEmail.mock.calls[0][0].to).toBe("admin@kiraroom.net");
  });

  it("a failed send releases the week so a later hour retries, and throws for @MonitoredJob", async () => {
    const { scheduler, tasks } = build(false);
    await expect(scheduler.sendWeek(NOW)).rejects.toThrow("weekly digest not sent");
    expect(tasks.size).toBe(0);
  });
});
