import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E configuration for KiraRoom (plan rev 3).
 *
 * The webServer block boots the backend + frontend in dev mode.
 * For CI, set CI=1 to reuse a pre-running stack (set BASE_URL / API_URL).
 *
 * Required services:
 *   - Postgres at DATABASE_URL (default in .env)
 *   - Backend (Nest) on http://localhost:3001
 *   - Frontend (Next.js) on http://localhost:3000
 */
const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const API_URL = process.env.API_URL ?? "http://localhost:3001/api/v1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command: "npm run dev",
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});

export const TEST_API_URL = API_URL;