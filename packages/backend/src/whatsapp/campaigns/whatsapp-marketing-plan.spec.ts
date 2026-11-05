import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { FeatureGuard } from "../../common/guards/feature.guard";
import { FEATURE_KEY_METADATA } from "../../common/decorators/feature.decorator";
import { PLAN_MATRIX, SubscriptionsService } from "../../payments/services/subscriptions.service";
import { WhatsAppCampaignsController } from "./whatsapp-campaigns.controller";

/**
 * The owner's decision of 2026-11-02: WhatsApp campaigns are Pro only
 * (whatsapp_marketing, in Pro, Empresa and the trial; not in Esencial).
 * An Esencial salon keeps reading its past campaigns, and can stop or
 * delete one, but cannot create, edit, send or resume.
 */
describe("whatsapp_marketing: WhatsApp campaigns are Pro only", () => {
  const subs = new SubscriptionsService(
    {} as any,
    { get: () => undefined } as any,
    { client: () => null, current: () => ({ taxEnabled: false }) } as any,
  );

  it("is in Pro and Empresa, not in Esencial; appointment notices stay in every plan", () => {
    expect(PLAN_MATRIX.pro).toContain("whatsapp_marketing");
    expect(PLAN_MATRIX.empresa).toContain("whatsapp_marketing");
    expect(PLAN_MATRIX.esencial).not.toContain("whatsapp_marketing");
    expect(PLAN_MATRIX.esencial).toContain("whatsapp_notifications");
    // Legacy plan names follow their rev-3 plan.
    expect(PLAN_MATRIX.basic).not.toContain("whatsapp_marketing");
    expect(PLAN_MATRIX.professional).toContain("whatsapp_marketing");
  });

  it("the trial mirrors Pro, so it includes campaigns", () => {
    const plan = subs.effectivePlan("esencial", true);
    expect(plan).toBe("pro");
    expect(subs.isFeatureEnabledForPlan(plan, "whatsapp_marketing")).toBe(true);
    expect(subs.isFeatureEnabledForPlan(subs.effectivePlan("esencial", false), "whatsapp_marketing")).toBe(false);
  });

  it("the Pro plan lists WhatsApp campaigns among its features, Esencial does not", () => {
    expect(subs.plans.pro.features.some((f) => /Campañas de WhatsApp/.test(f))).toBe(true);
    expect(subs.plans.esencial.features.some((f) => /Campañas de WhatsApp/.test(f))).toBe(false);
  });

  const reflector = new Reflector();
  const featureOf = (method: keyof WhatsAppCampaignsController) =>
    reflector.getAllAndOverride(FEATURE_KEY_METADATA, [
      WhatsAppCampaignsController.prototype[method] as any,
      WhatsAppCampaignsController,
    ]);

  it("creating, editing, the audience, sending to Meta and resuming need whatsapp_marketing", () => {
    for (const m of ["create", "update", "audience", "submit", "resume"] as const) {
      expect([m, featureOf(m)]).toEqual([m, "whatsapp_marketing"]);
    }
  });

  it("reading past campaigns, the plan check, cancelling and deleting stay open to every plan", () => {
    for (const m of ["list", "get", "access", "cancel", "remove"] as const) {
      expect([m, featureOf(m)]).toEqual([m, "whatsapp_notifications"]);
    }
  });

  function guardFor(method: keyof WhatsAppCampaignsController, enabled: (key: string) => boolean, httpMethod = "POST") {
    const guard = new FeatureGuard({ isEnabled: jest.fn(async (_t: string, key: string) => enabled(key)) } as any, reflector);
    const ctx: any = {
      getHandler: () => WhatsAppCampaignsController.prototype[method],
      getClass: () => WhatsAppCampaignsController,
      switchToHttp: () => ({
        getRequest: () => ({ method: httpMethod, user: { tenantId: "t1", subscriptionStatus: "active" } }),
      }),
    };
    return guard.canActivate(ctx);
  }

  it("an Esencial salon gets 403 FEATURE_NOT_IN_PLAN on a new campaign, and still lists its campaigns", async () => {
    const esencial = (key: string) => PLAN_MATRIX.esencial.includes(key as any);
    const err = await guardFor("create", esencial).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: "FEATURE_NOT_IN_PLAN", upgradeUrl: "/dashboard/billing" });
    await expect(guardFor("resume", esencial)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guardFor("submit", esencial)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guardFor("list", esencial, "GET")).resolves.toBe(true);
    await expect(guardFor("get", esencial, "GET")).resolves.toBe(true);
    await expect(guardFor("cancel", esencial)).resolves.toBe(true);
  });

  it("a Pro salon can create", async () => {
    await expect(guardFor("create", (key) => PLAN_MATRIX.pro.includes(key as any))).resolves.toBe(true);
  });
});
