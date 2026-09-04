import { test, expect } from "@playwright/test";
import { loginAs, seedTenant, uniqueSlug, TEST_API_URL } from "./fixtures/auth";

/**
 * Cancellation flow (rev 3 section 4.6).
 *
 * Verifies:
 *  - Cancelled tenant sees the "Tu suscripcion esta cancelada" banner on
 *    /dashboard/billing.
 *  - GET endpoints are still allowed (read-only mode).
 *  - POST /payments/subscription/cancel from a fresh tenant flips state to
 *    cancelled.
 *  - POST /payments/subscription/reactivate clears the cancellation.
 */
test.describe("Cancellation + read-only mode", () => {
  test("cancelled tenant sees banner and can still read", async ({ page }) => {
    const seed = await seedTenant({
      name: "Cancelled E2E",
      slug: uniqueSlug("cancelled"),
      plan: "pro",
      status: "cancelled",
      cancelled: true,
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    await page.goto("/dashboard/billing");
    await expect(
      page.getByText(/Tu suscripcion esta cancelada/i),
    ).toBeVisible();

    // Read endpoint still works
    const sub = await page.request.get(
      `${TEST_API_URL}/payments/subscription/current`,
    );
    expect(sub.ok()).toBeTruthy();
  });

  test("cancel from active flips to cancelled (status + cancelledAt set)", async ({ page }) => {
    const seed = await seedTenant({
      name: "Will Cancel E2E",
      slug: uniqueSlug("will-cancel"),
      plan: "pro",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);

    const res = await page.request.post(
      `${TEST_API_URL}/payments/subscription/cancel`,
      { data: { immediately: false } },
    );
    expect(res.ok()).toBeTruthy();

    const sub = await (
      await page.request.get(`${TEST_API_URL}/payments/subscription/current`)
    ).json();
    expect(sub.status).toBe("cancelled");
    expect(sub.cancelledAt).toBeTruthy();
    expect(sub.readOnlyUntil).toBeTruthy();
  });

  test("reactivate clears cancellation and returns checkoutUrl or stays active", async ({ page }) => {
    const seed = await seedTenant({
      name: "Reactivator E2E",
      slug: uniqueSlug("reactivator"),
      plan: "pro",
      status: "cancelled",
      cancelled: true,
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);

    const res = await page.request.post(
      `${TEST_API_URL}/payments/subscription/reactivate`,
    );
    // In dev without Stripe we expect 200 with checkoutUrl=null
    expect([200, 502]).toContain(res.status());

    const sub = await (
      await page.request.get(`${TEST_API_URL}/payments/subscription/current`)
    ).json();
    // Status flips back to active (or trialing if trialEnd still in the future)
    expect(["active", "trialing"]).toContain(sub.status);
  });
});