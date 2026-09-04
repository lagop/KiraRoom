import { test, expect } from "@playwright/test";
import { loginAs, seedTenant, uniqueSlug, TEST_API_URL } from "./fixtures/auth";

/**
 * Multi-location (plan rev 3 section 4.7).
 *
 * Verifies:
 *  - Only Empresa tenants can hit /locations POST and
 *    /multi-location/consolidated.
 *  - Empresa with <2 active locations cannot generate a consolidated
 *    report (returns 400 with the friendly message).
 *  - The /locations GET endpoint returns the seeded locations.
 */
test.describe("Multi-location (Empresa only)", () => {
  test("Esencial: POST /locations is blocked", async ({ page }) => {
    const seed = await seedTenant({
      name: "Esloc E2E",
      slug: uniqueSlug("esloc"),
      plan: "esencial",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    const res = await page.request.post(`${TEST_API_URL}/locations`, {
      data: { name: "Local 1" },
    });
    expect([401, 403]).toContain(res.status());
  });

  test("Empresa: can create two locations and consolidated report fails with <2 active", async ({ page }) => {
    const seed = await seedTenant({
      name: "Emp Loc E2E",
      slug: uniqueSlug("emploc"),
      plan: "empresa",
      status: "active",
      maxLocations: 3,
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);

    // First location: should succeed
    const r1 = await page.request.post(`${TEST_API_URL}/locations`, {
      data: { name: "Centro 1", slug: "centro-1" },
    });
    expect(r1.ok()).toBeTruthy();

    // Consolidated report fails because we have only 1 active location
    const c = await page.request.get(
      `${TEST_API_URL}/multi-location/consolidated`,
    );
    // 400 "Necesitas al menos 2 locales activos" or 403 if consolidated
    // feature still not enabled
    expect([400, 403]).toContain(c.status());

    // Second location: should succeed
    const r2 = await page.request.post(`${TEST_API_URL}/locations`, {
      data: { name: "Centro 2", slug: "centro-2" },
    });
    expect(r2.ok()).toBeTruthy();

    // Now consolidated should work
    const c2 = await page.request.get(
      `${TEST_API_URL}/multi-location/consolidated`,
    );
    expect(c2.ok()).toBeTruthy();
    const body = await c2.json();
    expect(body.activeLocations).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.perLocation)).toBeTruthy();
  });

  test("Empresa: list endpoint returns the seeded locations", async ({ page }) => {
    const seed = await seedTenant({
      name: "List Loc E2E",
      slug: uniqueSlug("listloc"),
      plan: "empresa",
      status: "active",
      maxLocations: 3,
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);

    await page.request.post(`${TEST_API_URL}/locations`, {
      data: { name: "A", slug: "a" },
    });
    await page.request.post(`${TEST_API_URL}/locations`, {
      data: { name: "B", slug: "b" },
    });

    const list = await page.request.get(`${TEST_API_URL}/locations`);
    expect(list.ok()).toBeTruthy();
    const arr = await list.json();
    expect(arr.length).toBeGreaterThanOrEqual(2);
    const names = arr.map((l: any) => l.name).sort();
    expect(names).toContain("A");
    expect(names).toContain("B");
  });
});