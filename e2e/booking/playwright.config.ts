import { defineConfig, devices } from "@playwright/test";

/**
 * The booking end-to-end test (booking-flow.spec.ts), run by `npm run
 * test:e2e` and by the "E2E booking" CI job. It drives servers that are
 * already running (no webServer block): see the spec's header for the env.
 */
export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results/e2e-booking",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // One retry in CI, for a slow runner; locally a failure shows at once.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices["Desktop Chrome"],
    // The runner's installed Chrome in CI (E2E_BROWSER_CHANNEL=chrome) saves
    // downloading Playwright's Chromium; locally its bundled Chromium.
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    locale: "es-ES",
    // The salon's zone: "today" in the panel and on the booking page is
    // the salon's day, whatever the machine's zone.
    timezoneId: "Europe/Madrid",
    // The attribute the frontend's test hooks use (data-test="...").
    testIdAttribute: "data-test",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
