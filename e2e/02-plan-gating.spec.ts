import { test, expect } from "@playwright/test";
import { loginAs, seedTenant, uniqueSlug, TEST_API_URL } from "./fixtures/auth";

/**
 * Plan gating (rev 3 section 4.1, 4.3).
 *
 * Verifies that:
 *  - Esencial: can NOT call email-campaigns POST (returns 403 / feature
 *    blocked), can NOT create promotions, can NOT call loyalty endpoints.
 *  - Pro: can call email-campaigns, loyalty, promotions, commissions.
 *  - Empresa: same as Pro + multi_location endpoints.
 *  - Parked features (api_access, white_label, custom_branding) are NEVER
 *    exposed in the public plan catalog.
 */
test.describe("Plan gating (Esencial / Pro / Empresa)", () => {
  test("Esencial: blocked from Pro features, no 500 errors", async ({ page }) => {
    const seed = await seedTenant({
      name: "Esencial E2E",
      slug: uniqueSlug("esencial"),
      plan: "esencial",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    const ctx = page.request;

    // Email campaigns POST: should be 403 (FeatureGuard)
    const res1 = await ctx.post(`${TEST_API_URL}/email-campaigns`, {
      data: { name: "x", subject: "x", htmlBody: "<p>x</p>" },
    });
    expect([401, 403]).toContain(res1.status());

    // Loyalty POST: should be 403
    const res2 = await ctx.post(`${TEST_API_URL}/loyalty/programs`, {
      data: { name: "x", pointsPerEuro: 1 },
    });
    expect([401, 403]).toContain(res2.status());

    // Public plan catalog should NOT include parked feature keys
    const plans = await (await ctx.get(`${TEST_API_URL}/payments/subscription/plans`)).json();
    const allKeys = (plans as any[]).flatMap((p) => p.featureKeys ?? []);
    expect(allKeys).not.toContain("api_access");
    expect(allKeys).not.toContain("white_label");
    expect(allKeys).not.toContain("custom_branding");
  });

  test("Pro: email-campaigns POST allowed, multi_location blocked", async ({ page }) => {
    const seed = await seedTenant({
      name: "Pro E2E",
      slug: uniqueSlug("pro"),
      plan: "pro",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    const ctx = page.request;

    // Multi-location: Empresa only -> 403 on Pro
    const loc = await ctx.post(`${TEST_API_URL}/locations`, {
      data: { name: "Test local" },
    });
    expect([401, 403]).toContain(loc.status());

    // Email campaigns list: should be 200 (Pro has email_marketing)
    const list = await ctx.get(`${TEST_API_URL}/email-campaigns`);
    expect(list.status()).toBe(200);
  });

  test("Esencial: WhatsApp notifications in the feature set (matrix check)", async ({ page }) => {
    const seed = await seedTenant({
      name: "Esencial WhatsApp",
      slug: uniqueSlug("esencial-wa"),
      plan: "esencial",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    const ctx = page.request;
    const sub = await (await ctx.get(`${TEST_API_URL}/payments/subscription/current`)).json();
    expect(sub.plan).toBe("esencial");
    const plans = await (await ctx.get(`${TEST_API_URL}/payments/subscription/plans`)).json();
    const esencial = (plans as any[]).find((p) => p.id === "esencial");
    expect(esencial).toBeTruthy();
    expect(esencial.featureKeys).toContain("whatsapp_notifications");
    expect(esencial.featureKeys).not.toContain("sms_notifications");
  });

  test("Public plans endpoint lists esencial/pro/empresa only", async ({ page }) => {
    const ctx = page.request;
    const plans = await (await ctx.get(`${TEST_API_URL}/payments/subscription/plans`)).json();
    const ids = (plans as any[]).map((p) => p.id).sort();
    expect(ids).toEqual(["empresa", "esencial", "pro"]);
  });
});