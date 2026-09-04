import { test, expect } from "@playwright/test";
import { loginAs, seedTenant, uniqueSlug } from "./fixtures/auth";

/**
 * Trial 14-day banner (plan rev 3 section 4.5).
 *
 * Verifies:
 *  - Banner shows the countdown when the tenant is in trial.
 *  - Banner hides when the trial is past.
 *  - Banner suggests the upgrade CTA (links to /dashboard/billing).
 */
test.describe("Trial 14-day banner", () => {
  test("shows countdown and links to billing when in trial", async ({ page }) => {
    const slug = uniqueSlug("trial");
    const seed = await seedTenant({
      name: "Trial E2E Salon",
      slug,
      plan: "esencial",
      status: "trialing",
      trialDaysRemaining: 7,
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    await page.goto("/dashboard");

    const banner = page.getByTestId("trial-banner").or(
      page.locator("text=/d\\u00edas? de prueba Pro/i").first(),
    );
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/7/);
    await expect(banner.getByRole("link", { name: /gestionar plan|plan/i }))
      .toHaveAttribute("href", "/dashboard/billing");
  });

  test("hides when the tenant is on an active paid plan", async ({ page }) => {
    const slug = uniqueSlug("active");
    const seed = await seedTenant({
      name: "Active E2E Salon",
      slug,
      plan: "pro",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    await page.goto("/dashboard");
    await expect(
      page.locator("text=/d\\u00edas? de prueba Pro/i"),
    ).toHaveCount(0);
  });

  test("hides when the trial has expired (status=cancelled)", async ({ page }) => {
    const slug = uniqueSlug("expired");
    const seed = await seedTenant({
      name: "Expired E2E Salon",
      slug,
      plan: "esencial",
      status: "cancelled",
      cancelled: true,
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    await page.goto("/dashboard");
    await expect(
      page.locator("text=/d\\u00edas? de prueba Pro/i"),
    ).toHaveCount(0);
  });
});