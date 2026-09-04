import { test, expect } from "@playwright/test";
import { loginAs, seedTenant, uniqueSlug, TEST_API_URL } from "./fixtures/auth";

/**
 * Add-on web_domain (plan rev 3 section 4.8).
 *
 * Verifies:
 *  - The status endpoint starts disabled.
 *  - Availability check returns the mock response.
 *  - Purchase (with no Stripe) activates the add-on locally.
 *  - isEnabled('web_domain') flips to true after activation.
 */
test.describe("Add-on web_domain", () => {
  test("starts disabled and can be activated via the service", async ({ page }) => {
    const seed = await seedTenant({
      name: "Domain E2E",
      slug: uniqueSlug("domain"),
      plan: "pro",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);

    const status = await page.request.get(`${TEST_API_URL}/web-domain`);
    expect(status.ok()).toBeTruthy();
    const s0 = await status.json();
    expect(s0.enabled).toBe(false);

    const avail = await page.request.post(
      `${TEST_API_URL}/web-domain/check-availability`,
      { data: { domain: "salon-demo.com" } },
    );
    expect(avail.ok()).toBeTruthy();
    const a = await avail.json();
    expect(a.domain).toBe("salon-demo.com");
    expect(typeof a.available).toBe("boolean");

    const purchase = await page.request.post(
      `${TEST_API_URL}/web-domain/purchase`,
      { data: { domain: "salon-demo.com" } },
    );
    expect(purchase.ok()).toBeTruthy();

    const s1 = await (
      await page.request.get(`${TEST_API_URL}/web-domain`)
    ).json();
    expect(s1.enabled).toBe(true);
    expect(s1.domain).toBe("salon-demo.com");
  });

  test("rejects invalid domains", async ({ page }) => {
    const seed = await seedTenant({
      name: "Bad Domain E2E",
      slug: uniqueSlug("baddomain"),
      plan: "pro",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    const res = await page.request.post(
      `${TEST_API_URL}/web-domain/check-availability`,
      { data: { domain: "not a domain" } },
    );
    expect([400, 422]).toContain(res.status());
  });
});