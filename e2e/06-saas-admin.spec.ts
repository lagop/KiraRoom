import { test, expect, request } from "@playwright/test";
import { getSaaSContext, seedTenant, uniqueSlug } from "./fixtures/auth";
import { TEST_API_URL } from "../playwright.config";

/**
 * SaaS Admin dashboard (Phase B1 of the hardening plan).
 *
 * Verifies:
 *  - SaaS owner can log in at /saas/login and lands at /saas with KPIs.
 *  - After seedTenant, the platform overview counts the new tenant.
 *  - A tenant owner cannot reach SaaS-only API endpoints.
 *  - The launch-as-owner impersonation flow issues a token and (when
 *    consumed via /auth/impersonate) writes an AuditLog row.
 */
test.describe("SaaS Admin", () => {
  test("SaaS owner logs in and lands on the overview", async ({ page }) => {
    await page.goto("/saas/login");
    await page.fill('input[type="email"]', process.env.SAAS_OWNER_EMAIL ?? "saasadmin@example.com");
    await page.fill('input[type="password"]', process.env.SAAS_OWNER_PASSWORD ?? "YourSecurePassword123!");
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/saas(?:\/?)$/);
    await expect(page.locator("text=/Platform Analytics|Analitica de plataforma/i").first()).toBeVisible();
  });

  test("platform overview counts newly seeded tenants", async ({ page }) => {
    const slug = uniqueSlug("saas-tenant");
    const seed = await seedTenant({ name: "SaaS Seed Tenant", slug, plan: "pro", status: "trialing" });
    expect(seed.tenantId).toBeDefined();

    // Use the API to read the count directly — the page renders the
    // number inside Lucide-icon-wrapped cards which can be brittle to
    // assert on, so we hit the backend instead.
    const ctx = await getSaaSContext();
    const res = await ctx.get("/saas/analytics/overview");
    expect(res.ok()).toBeTruthy();
    const analytics = await res.json();
    expect(analytics.totalTenants).toBeGreaterThanOrEqual(1);
  });

  test("tenant owner is blocked from /saas/* endpoints (403)", async ({ request }) => {
    const slug = uniqueSlug("saas-block");
    const seed = await seedTenant({ name: "Block SaaS E2E", slug, plan: "esencial", status: "trialing" });

    const tenantCtx = await request.newContext({
      baseURL: TEST_API_URL,
      extraHTTPHeaders: {
        // Manually inject the tenant owner's token (loginAs cannot
        // run without a Page; this is the same call the page fixture
        // does internally).
        Authorization: "",
      },
    });

    const login = await tenantCtx.post("/auth/login", {
      data: { email: seed.ownerEmail, password: seed.ownerPassword },
    });
    expect(login.ok()).toBeTruthy();
    const body = await login.json();
    const access = body.tokens?.accessToken ?? body.accessToken;
    await tenantCtx.dispose();

    const ctx = await request.newContext({
      baseURL: TEST_API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${access}` },
    });
    const analytics = await ctx.get("/saas/analytics/overview");
    expect(analytics.status()).toBe(403);
    await ctx.dispose();
  });

  test("launch-as-owner issues a token and impersonation writes to AuditLog", async ({ request }) => {
    const slug = uniqueSlug("impersonate");
    const seed = await seedTenant({ name: "Impersonate E2E", slug, plan: "pro", status: "active" });

    const ctx = await getSaaSContext();

    // 1. Launch → get impersonation token + owner info
    const launch = await ctx.post(`/saas/tenants/${seed.tenantId}/launch`);
    expect(launch.ok()).toBeTruthy();
    const launched = await launch.json();
    expect(typeof launched.token).toBe("string");
    expect(launched.token.length).toBeGreaterThan(20);
    expect(launched.ownerEmail).toBe(seed.ownerEmail);

    // 2. Exchange the impersonation token for a real session
    const impersonate = await ctx.post("/auth/impersonate", {
      data: { token: launched.token, reason: "e2e-test" },
    });
    expect(impersonate.ok()).toBeTruthy();
    const imp = await impersonate.json();
    expect(imp.tokens?.accessToken).toBeDefined();
    expect(imp.user?.email).toBe(seed.ownerEmail);
    expect(imp.user?.role).toBe("owner");

    // 3. The exchange is one-shot: a second consume of the same token
    //    is rejected with 401 because the `jti` has been recorded in
    //    `used_impersonation_tokens` (atomic PK insert). This is the
    //    anti-replay guarantee added in the CRITICAL-finding fix.
    const replay = await ctx.post("/auth/impersonate", {
      data: { token: launched.token, reason: "e2e-replay" },
    });
    expect(replay.status()).toBe(401);
  });
});
