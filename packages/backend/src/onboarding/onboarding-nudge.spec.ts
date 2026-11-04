import { OnboardingGroup } from "@prisma/client";
import { OnboardingNudgeService } from "./onboarding-nudge.service";
import { OnboardingNudgeController } from "./onboarding-nudge.controller";

/**
 * Audit 7 D17: one email on day 2 after signup, only when a mandatory step is
 * missing, never twice, with a one-click unsubscribe that the job respects.
 */
const SECRET = ["fake", "jwt", "secret", "for", "tests"].join("-");
const NOW = new Date("2026-11-06T10:00:00.000Z");
const H = 3_600_000;

const DEFS = [
  { key: "workspace_business", group: OnboardingGroup.linear_required, href: "/dashboard/settings/salon" },
  { key: "service_create", group: OnboardingGroup.linear_required, href: "/dashboard/services/new" },
  { key: "schedule_set", group: OnboardingGroup.linear_required, href: "/dashboard/professionals" },
  { key: "clients_import", group: OnboardingGroup.checklist_optional, href: "/dashboard/clients" },
];

function harness(opts: { detect?: Record<string, boolean>; createdAt?: Date; optedOut?: boolean; emailOk?: boolean; skipped?: boolean } = {}) {
  const tenant: any = { id: "t1", name: "Salón Luna", createdAt: opts.createdAt ?? new Date(NOW.getTime() - 50 * H), onboardingNudgeSentAt: null, deletedAt: null, subscriptionStatus: "trialing" };
  const user: any = { id: "u1", email: "duena@salon.test", firstName: "Ana", productTipsOptOutAt: opts.optedOut ? new Date() : null };
  const prisma: any = {
    tenant: {
      findMany: jest.fn(async ({ where }: any) =>
        tenant.onboardingNudgeSentAt === null && tenant.createdAt > where.createdAt.gt && tenant.createdAt <= where.createdAt.lte ? [{ id: tenant.id, name: tenant.name }] : [],
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const match = where.onboardingNudgeSentAt === null ? tenant.onboardingNudgeSentAt === null : tenant.onboardingNudgeSentAt?.getTime() === where.onboardingNudgeSentAt?.getTime();
        if (!match) return { count: 0 };
        Object.assign(tenant, data);
        return { count: 1 };
      }),
    },
    user: {
      findFirst: jest.fn(async () => ({ ...user })),
      findUnique: jest.fn(async ({ where }: any) => (where.id === user.id ? { ...user } : null)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.id !== user.id || user.productTipsOptOutAt) return { count: 0 };
        Object.assign(user, data);
        return { count: 1 };
      }),
    },
  };
  const detect = { workspace_business: true, service_create: false, schedule_set: false, clients_import: false, ...opts.detect };
  const onboarding = { getState: jest.fn(async () => ({ defs: DEFS, detectResults: detect, steps: {} })) };
  const email = {
    sendOnboardingReminder: jest.fn(async () =>
      opts.skipped ? { success: false, skipped: true, error: "email_bounced" } : opts.emailOk === false ? { success: false, error: "down" } : { success: true },
    ),
  };
  const env: Record<string, string> = { JWT_SECRET: SECRET, APP_BASE_URL: "https://app.kiraroom.test", API_BASE_URL: "https://api.kiraroom.test" };
  const config = { get: (k: string) => env[k] };
  const service = new OnboardingNudgeService(prisma, onboarding as any, email as any, config as any);
  return { service, tenant, user, email, prisma };
}

describe("the day-2 onboarding reminder", () => {
  it("names the missing mandatory steps with links, and carries the one-click unsubscribe", async () => {
    const t = harness();
    expect(await t.service.run(NOW)).toBe(1);
    const sent = (t.email.sendOnboardingReminder.mock.calls as any[])[0][0];
    expect(sent).toMatchObject({ to: "duena@salon.test", firstName: "Ana", tenantName: "Salón Luna" });
    expect(sent.missing).toEqual([
      { key: "service_create", label: "Tu primer servicio", url: "https://app.kiraroom.test/dashboard/services/new" },
      { key: "schedule_set", label: "El horario de tu equipo", url: "https://app.kiraroom.test/dashboard/professionals" },
    ]);
    expect(sent.unsubscribeUrl).toMatch(/^https:\/\/app\.kiraroom\.test\/public\/baja-consejos\//);
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/api\.kiraroom\.test\/api\/v1\/public\/email\/tips-unsubscribe\//);
    expect(t.tenant.onboardingNudgeSentAt).toEqual(NOW);
  });

  it("once: a second run sends nothing", async () => {
    const t = harness();
    await t.service.run(NOW);
    expect(await t.service.run(new Date(NOW.getTime() + H))).toBe(0);
    expect(t.email.sendOnboardingReminder).toHaveBeenCalledTimes(1);
  });

  it("nothing mandatory missing: nothing sent (an optional step does not count)", async () => {
    const t = harness({ detect: { service_create: true, schedule_set: true } });
    expect(await t.service.run(NOW)).toBe(0);
    expect(t.email.sendOnboardingReminder).not.toHaveBeenCalled();
    expect(t.tenant.onboardingNudgeSentAt).toBeNull();
  });

  it("only on day 2", async () => {
    expect(await harness({ createdAt: new Date(NOW.getTime() - 47 * H) }).service.run(NOW)).toBe(0);
    expect(await harness({ createdAt: new Date(NOW.getTime() - 73 * H) }).service.run(NOW)).toBe(0);
  });

  it("an owner who unsubscribed gets none", async () => {
    const t = harness({ optedOut: true });
    expect(await t.service.run(NOW)).toBe(0);
    expect(t.email.sendOnboardingReminder).not.toHaveBeenCalled();
  });

  it("a failed email gives the claim back for the next hour; a bounced address does not", async () => {
    const failed = harness({ emailOk: false });
    expect(await failed.service.run(NOW)).toBe(0);
    expect(failed.tenant.onboardingNudgeSentAt).toBeNull();
    const bounced = harness({ skipped: true });
    expect(await bounced.service.run(NOW)).toBe(0);
    expect(bounced.tenant.onboardingNudgeSentAt).toEqual(NOW);
  });
});

describe("unsubscribing from the tips", () => {
  it("a signed token: GET describes, POST unsubscribes (idempotent), and the job respects it", async () => {
    const t = harness();
    const controller = new OnboardingNudgeController(t.service);
    const token = t.service.tokenFor("u1");
    expect(await controller.describe(token)).toEqual({ unsubscribed: false });
    expect(t.user.productTipsOptOutAt).toBeNull();
    expect(await controller.unsubscribe(token)).toEqual({ unsubscribed: true });
    expect(t.user.productTipsOptOutAt).toBeInstanceOf(Date);
    expect(await controller.unsubscribe(token)).toEqual({ unsubscribed: true });
    expect(await controller.describe(token)).toEqual({ unsubscribed: true });
    expect(await t.service.run(NOW)).toBe(0);
  });

  it("a forged, altered or foreign token is refused", async () => {
    const t = harness();
    const controller = new OnboardingNudgeController(t.service);
    const token = t.service.tokenFor("u1");
    const [payload] = token.split(".");
    const other = Buffer.from("t.u2").toString("base64url");
    await expect(controller.unsubscribe(`${other}.${token.split(".")[1]}`)).rejects.toThrow("Enlace no válido");
    await expect(controller.unsubscribe(`${payload}.x`)).rejects.toThrow("Enlace no válido");
    await expect(controller.describe("nope")).rejects.toThrow("Enlace no válido");
    // Signed for a user that does not exist.
    await expect(controller.unsubscribe(t.service.tokenFor("ghost"))).rejects.toThrow("Enlace no válido");
    expect(t.user.productTipsOptOutAt).toBeNull();
  });
});
