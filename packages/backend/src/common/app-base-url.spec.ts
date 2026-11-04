import { appBaseUrl, DEFAULT_APP_BASE_URL } from "./app-base-url";

describe("appBaseUrl", () => {
  const from = (env: Record<string, string | undefined>) => (k: string) => env[k];

  it("APP_BASE_URL first, then FRONTEND_URL, without a trailing slash", () => {
    expect(appBaseUrl(from({ APP_BASE_URL: "https://a.test/", FRONTEND_URL: "https://b.test" }))).toBe("https://a.test");
    expect(appBaseUrl(from({ APP_BASE_URL: " ", FRONTEND_URL: "https://b.test//" }))).toBe("https://b.test");
  });

  it("falls back to the app's own domain, app.kiraroom.net", () => {
    expect(appBaseUrl(from({}))).toBe("https://app.kiraroom.net");
    expect(DEFAULT_APP_BASE_URL).toBe("https://app.kiraroom.net");
  });

  it("no backend fallback points at app.kiraroom.com any more", () => {
    const fs = require("fs");
    const path = require("path");
    const files = [
      "../payments/webhooks.controller.ts",
      "../payments/trial-expiry.scheduler.ts",
      "../payments/grace-period.scheduler.ts",
      "../payments/read-only-notice.service.ts",
      "../channel-health/channel-attention.scheduler.ts",
      "../saas/invites/invites.service.ts",
      "../invoices/fiscal/fiscal-retry.queue.ts",
    ];
    for (const f of files) {
      expect(fs.readFileSync(path.join(__dirname, f), "utf8")).not.toContain("app.kiraroom.com");
    }
  });
});
