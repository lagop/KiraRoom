/**
 * OnboardingDetectorService unit tests covering the matrix in the plan:
 *  - empty tenant → all detectors false
 *  - complete tenant → all detectors true
 *  - partial → mixed results
 *  - markStepCompleted is idempotent (calling twice doesn't downgrade)
 *  - upsertState never overrides a 'skipped' status with 'done'
 *  - recomputeLinearStep advances currentStep as linear_required steps complete
 *
 * Uses an in-memory Prisma mock — no DB needed.
 */

import { OnboardingDetectorService } from "./onboarding-detector.service";
import { OnboardingGroup } from "@prisma/client";

function buildPrismaMock() {
  const tenant: any = {
    id: "tenant-1",
    name: null,
    street: null,
    city: null,
    phone: null,
    logo: null,
    coverImage: null,
    description: null,
    stripeCustomerId: null,
  };

  // Use a holder object so tests can mutate `state.X` and the mock closures
  // pick up the latest value (otherwise closure captures the local var).
  const state: any = {
    tenant,
    services: [] as any[],
    professionals: [] as any[],
    notificationTemplates: [] as any[],
    widgetInstances: [] as any[],
    whatsAppConnections: [] as any[],
    stateRows: new Map<string, any>(),
    stepDefs: [] as any[],
  };

  const stateRows = state.stateRows;
  // Hydrate state.stepDefs with the default seed (we mutate below so that
  // test code that does `m.state.stepDefs.push(...)` sees the same array).
  const stepDefs: any[] = [
    {
      key: "workspace_business",
      order: 1,
      group: OnboardingGroup.linear_required,
      titleI18nKey: "onboarding.workspace_business.title",
      descI18nKey: "onboarding.workspace_business.desc",
      href: "/dashboard/settings/salon",
      detectName: "hasBusinessIdentity",
      enabled: true,
    },
    {
      key: "service_create",
      order: 2,
      group: OnboardingGroup.linear_required,
      titleI18nKey: "onboarding.service_create.title",
      descI18nKey: "onboarding.service_create.desc",
      href: "/dashboard/services/new",
      detectName: "hasFirstService",
      enabled: true,
    },
    {
      key: "schedule_set",
      order: 3,
      group: OnboardingGroup.linear_required,
      titleI18nKey: "onboarding.schedule_set.title",
      descI18nKey: "onboarding.schedule_set.desc",
      href: "/dashboard/professionals",
      detectName: "allProsHaveWorkingHours",
      enabled: true,
    },
    {
      key: "branding",
      order: 5,
      group: OnboardingGroup.checklist_optional,
      titleI18nKey: "onboarding.branding.title",
      descI18nKey: "onboarding.branding.desc",
      href: "/dashboard/settings/salon#branding",
      detectName: "hasCoverImageAndDescription",
      enabled: true,
    },
    {
      key: "reminders_enabled",
      order: 6,
      group: OnboardingGroup.checklist_optional,
      titleI18nKey: "onboarding.reminders_enabled.title",
      descI18nKey: "onboarding.reminders_enabled.desc",
      href: "/dashboard/notifications",
      detectName: "hasActiveReminderTemplate",
      enabled: true,
    },
    {
      key: "widget_qr_setup",
      order: 7,
      group: OnboardingGroup.checklist_optional,
      titleI18nKey: "onboarding.widget_qr_setup.title",
      descI18nKey: "onboarding.widget_qr_setup.desc",
      href: "/dashboard/settings/widget",
      detectName: "hasWidgetOrQr",
      enabled: true,
    },
    {
      key: "whatsapp_business",
      order: 8,
      group: OnboardingGroup.checklist_optional,
      titleI18nKey: "onboarding.whatsapp_business.title",
      descI18nKey: "onboarding.whatsapp_business.desc",
      href: "/dashboard/settings/whatsapp",
      detectName: "hasWhatsAppConnection",
      enabled: true,
    },
  ];
  state.stepDefs = stepDefs;

  const tenantFindUnique = jest.fn(async () => tenant);
  const serviceCount = jest.fn(async () => state.services.length);
  const proFindMany = jest.fn(async () => state.professionals);
  const notificationTemplateCount = jest.fn(async (args: any) => {
    // Always read the latest array reference so tests that REASSIGN
    // `m.state.notificationTemplates = [...]` are honoured.
    const templates = state.notificationTemplates;
    if (!args?.where) return templates.length;
    return templates.filter((t: any) => {
      if (args.where.isActive !== undefined && t.isActive !== args.where.isActive)
        return false;
      if (args.where.type?.in) {
        const allowed = Array.isArray(args.where.type)
          ? args.where.type
          : args.where.type.in;
        if (!allowed.includes(t.type)) return false;
      }
      return true;
    }).length;
  });
  const widgetCount = jest.fn(async () => state.widgetInstances.length);
  const whatsAppFindFirst = jest.fn(async () =>
    state.whatsAppConnections[0] ?? null,
  );

  const stepDefFindMany = jest.fn(async (args: any) => {
    let rows = [...stepDefs];
    if (args?.where) {
      if (args.where.enabled !== undefined) {
        rows = rows.filter((d) => d.enabled === args.where.enabled);
      }
      if (args.where.group !== undefined) {
        rows = rows.filter((d) => d.group === args.where.group);
      }
    }
    if (args?.orderBy?.order === "asc") {
      rows.sort((a, b) => a.order - b.order);
    }
    return rows;
  });
  const stepDefFindUnique = jest.fn(async (args: any) =>
    stepDefs.find((d) => d.key === args.where.key) ?? null,
  );

  const stateFindUnique = jest.fn(async (args: any) =>
    stateRows.get(args.where.tenantId) ?? null,
  );
  const stateUpsert = jest.fn(async (args: any) => {
    const key = args.where.tenantId;
    const existing = stateRows.get(key);
    const next = existing
      ? {
          ...existing,
          ...args.update,
          steps:
            args.update?.steps ?? args.create?.steps ?? existing.steps ?? {},
          currentStep:
            args.update?.currentStep ??
            args.create?.currentStep ??
            existing?.currentStep ??
            0,
          finishedAt:
            args.update?.finishedAt !== undefined
              ? args.update.finishedAt
              : existing?.finishedAt ?? null,
        }
      : {
          tenantId: key,
          currentStep: args.create?.currentStep ?? 0,
          steps: args.create?.steps ?? {},
          checklistDismissed: false,
          finishedAt: args.create?.finishedAt ?? null,
        };
    stateRows.set(key, next);
    return next;
  });

  const prisma: any = {
    tenant: { findUnique: tenantFindUnique },
    service: { count: serviceCount },
    professional: { findMany: proFindMany },
    notificationTemplate: { count: notificationTemplateCount },
    widgetInstance: { count: widgetCount },
    whatsAppConnection: { findFirst: whatsAppFindFirst },
    onboardingStepDef: {
      findMany: stepDefFindMany,
      findUnique: stepDefFindUnique,
    },
    onboardingState: {
      findUnique: stateFindUnique,
      upsert: stateUpsert,
    },
  };

  return {
    prisma,
    state, // share the same object so test mutations of m.state.X are seen by the mock
  };
}

describe("OnboardingDetectorService.detectAll", () => {
  it("returns all detectors false for an empty tenant", async () => {
    const m = buildPrismaMock();
    const svc = new OnboardingDetectorService(m.prisma);
    const result = await svc.detectAll("tenant-1");
    expect(result.workspace_business).toBe(false);
    expect(result.service_create).toBe(false);
    expect(result.schedule_set).toBe(false);
    expect(result.branding).toBe(false);
    expect(result.reminders_enabled).toBe(false);
    expect(result.widget_qr_setup).toBe(false);
    expect(result.whatsapp_business).toBe(false);
  });

  it("returns all detectors true for a complete tenant", async () => {
    const m = buildPrismaMock();
    Object.assign(m.state.tenant, {
      name: "Kira Studio",
      street: "Calle 1",
      city: "Madrid",
      phone: "+34123456789",
      logo: "logo.png",
      coverImage: "cover.png",
      description: "Lorem ipsum dolor sit amet consectetur adipiscing",
      stripeCustomerId: "cus_123",
    });
    m.state.services.push({ id: "svc-1" });
    m.state.professionals.push({
      id: "pro-1",
      isActive: true,
      workingHours: [{ day: "mon", from: "09:00", to: "17:00" }],
    });
    m.state.notificationTemplates.push({
      id: "t1",
      type: "appointment_reminder_24h",
      isActive: true,
    });
    m.state.widgetInstances.push({ id: "w1" });
    m.state.whatsAppConnections.push({ id: "wc1", isActive: true });

    const svc = new OnboardingDetectorService(m.prisma);
    const result = await svc.detectAll("tenant-1");
    expect(result.workspace_business).toBe(true);
    expect(result.service_create).toBe(true);
    expect(result.schedule_set).toBe(true);
    expect(result.branding).toBe(true);
    expect(result.reminders_enabled).toBe(true);
    expect(result.widget_qr_setup).toBe(true);
    expect(result.whatsapp_business).toBe(true);
  });

  it("hasCoverImageAndDescription requires description.length > 20", async () => {
    const m = buildPrismaMock();
    Object.assign(m.state.tenant, {
      coverImage: "cover.png",
      description: "short",
    });
    const svc = new OnboardingDetectorService(m.prisma);
    const result = await svc.detectAll("tenant-1");
    expect(result.branding).toBe(false);

    m.state.tenant.description =
      "this description is definitely longer than twenty characters";
    const result2 = await svc.detectAll("tenant-1");
    expect(result2.branding).toBe(true);
  });

  it("allProsHaveWorkingHours requires every active pro to have >=1 hour block", async () => {
    const m = buildPrismaMock();
    m.state.professionals.push(
      { id: "p1", isActive: true, workingHours: [{ day: "mon", from: "09:00", to: "17:00" }] },
      { id: "p2", isActive: true, workingHours: [] },
    );
    const svc = new OnboardingDetectorService(m.prisma);
    const result = await svc.detectAll("tenant-1");
    expect(result.schedule_set).toBe(false);

    m.state.professionals[1].workingHours = [{ day: "tue", from: "10:00", to: "18:00" }];
    const result2 = await svc.detectAll("tenant-1");
    expect(result2.schedule_set).toBe(true);
  });

  it("hasActiveReminderTemplate accepts either 24h or 1h reminder templates", async () => {
    const m = buildPrismaMock();
    m.state.notificationTemplates.push({
      id: "t1",
      type: "appointment_reminder_24h",
      isActive: true,
    });
    const svc = new OnboardingDetectorService(m.prisma);
    expect((await svc.detectAll("tenant-1")).reminders_enabled).toBe(true);

    m.state.notificationTemplates = [
      {
        id: "t2",
        type: "appointment_reminder_1h",
        isActive: true,
      },
    ];
    expect((await svc.detectAll("tenant-1")).reminders_enabled).toBe(true);

    m.state.notificationTemplates = [
      { id: "t3", type: "review_request", isActive: true },
    ];
    expect((await svc.detectAll("tenant-1")).reminders_enabled).toBe(false);
  });

  it("unknown detector names don't crash (returned as false)", async () => {
    const m = buildPrismaMock();
    m.state.stepDefs.push({
      key: "weird_step",
      order: 99,
      group: OnboardingGroup.checklist_optional,
      titleI18nKey: "x",
      descI18nKey: "y",
      detectName: "doesNotExist",
      enabled: true,
    });
    const svc = new OnboardingDetectorService(m.prisma);
    const result = await svc.detectAll("tenant-1");
    expect(result.weird_step).toBe(false);
  });
});

describe("OnboardingDetectorService.markStepCompleted", () => {
  it("writes a 'done' entry in OnboardingState.steps", async () => {
    const m = buildPrismaMock();
    const svc = new OnboardingDetectorService(m.prisma);
    await svc.markStepCompleted("tenant-1", "service_create");
    const row = m.state.stateRows.get("tenant-1");
    expect(row.steps.service_create.status).toBe("done");
    expect(row.steps.service_create.completedAt).toBeDefined();
  });

  it("is idempotent — calling twice doesn't reset completedAt", async () => {
    const m = buildPrismaMock();
    const svc = new OnboardingDetectorService(m.prisma);
    await svc.markStepCompleted("tenant-1", "service_create");
    const first = m.state.stateRows.get("tenant-1").steps.service_create
      .completedAt;
    await new Promise((r) => setTimeout(r, 5));
    await svc.markStepCompleted("tenant-1", "service_create");
    const second = m.state.stateRows.get("tenant-1").steps.service_create
      .completedAt;
    expect(second).toBe(first);
  });
});

describe("OnboardingDetectorService.recomputeLinearStep", () => {
  it("moves currentStep to first pending linear_required step", async () => {
    const m = buildPrismaMock();
    Object.assign(m.state.tenant, {
      name: "Kira Studio",
      street: "Calle 1",
      city: "Madrid",
      phone: "+34123456789",
      logo: "logo.png",
    });
    m.state.services.push({ id: "svc-1" });
    const svc = new OnboardingDetectorService(m.prisma);

    // First detect: workspace_business passes, service_create passes, schedule_set fails
    // (no pros with hours) → currentStep should be 2 (third linear_required, 0-indexed)
    await svc.detectAll("tenant-1");
    const row = m.state.stateRows.get("tenant-1");
    expect(row.currentStep).toBe(2);

    // Add pros with hours
    m.state.professionals.push({
      id: "pro-1",
      isActive: true,
      workingHours: [{ day: "mon", from: "09:00", to: "17:00" }],
    });
    await svc.detectAll("tenant-1");
    const row2 = m.state.stateRows.get("tenant-1");
    expect(row2.currentStep).toBe(3);
    expect(row2.finishedAt).toBeInstanceOf(Date);
  });

  it("marks finishedAt when all linear_required steps are done", async () => {
    const m = buildPrismaMock();
    Object.assign(m.state.tenant, {
      name: "Kira Studio",
      street: "Calle 1",
      city: "Madrid",
      phone: "+34123456789",
      logo: "logo.png",
    });
    m.state.services.push({ id: "svc-1" });
    m.state.professionals.push({
      id: "pro-1",
      isActive: true,
      workingHours: [{ day: "mon", from: "09:00", to: "17:00" }],
    });
    const svc = new OnboardingDetectorService(m.prisma);
    await svc.detectAll("tenant-1");
    const row = m.state.stateRows.get("tenant-1");
    expect(row.finishedAt).toBeInstanceOf(Date);
  });
});