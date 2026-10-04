import { test, expect } from "@playwright/test";
import { loginAs, seedTenant, uniqueSlug, TEST_API_URL } from "./fixtures/auth";

/**
 * The salon's own domain (bring-your-own, verified by DNS).
 *
 * The old flow "checked availability" by suffix and "purchased" a domain by
 * flipping a flag. Now:
 *  - the status lists the public page URL and no domain at first;
 *  - saving a domain returns it unverified, with the CNAME and TXT records;
 *  - verifying a domain nobody pointed at us fails with a reason;
 *  - invalid and platform domains are refused;
 *  - the old purchase endpoints are gone.
 */
test.describe("Dominio propio", () => {
  test("connect a domain and get the DNS records", async ({ page }) => {
    const seed = await seedTenant({
      name: "Domain E2E",
      slug: uniqueSlug("domain"),
      plan: "pro",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);

    const s0 = await (await page.request.get(`${TEST_API_URL}/web-domain`)).json();
    expect(s0.domain).toBeNull();
    expect(s0.publicUrl).toContain("/sites/");

    const saved = await page.request.put(`${TEST_API_URL}/web-domain`, {
      data: { domain: "https://Reservas.Salon-Demo.example/" },
    });
    expect(saved.ok()).toBeTruthy();
    const s1 = await saved.json();
    expect(s1.domain.name).toBe("reservas.salon-demo.example");
    expect(s1.domain.verified).toBe(false);
    expect(s1.domain.records.map((r: any) => r.type)).toEqual(["CNAME", "TXT"]);

    const verified = await (await page.request.post(`${TEST_API_URL}/web-domain/verify`)).json();
    expect(verified.domain.verified).toBe(false);
    expect(verified.domain.lastCheckError).toBeTruthy();

    const purchase = await page.request.post(`${TEST_API_URL}/web-domain/purchase`, {
      data: { domain: "salon-demo.com" },
    });
    expect(purchase.status()).toBe(404);
  });

  test("rejects invalid and platform domains", async ({ page }) => {
    const seed = await seedTenant({
      name: "Bad Domain E2E",
      slug: uniqueSlug("baddomain"),
      plan: "pro",
      status: "active",
    });
    await loginAs(page, seed.ownerEmail, seed.ownerPassword);
    for (const domain of ["not a domain", "app.kiraroom.net"]) {
      const res = await page.request.put(`${TEST_API_URL}/web-domain`, { data: { domain } });
      expect(res.status()).toBe(400);
    }
  });
});
