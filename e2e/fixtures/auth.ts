import { APIRequestContext, Page, request } from "@playwright/test";
export { TEST_API_URL } from "../../playwright.config";

import { TEST_API_URL } from "../../playwright.config";

const SAAS_OWNER_EMAIL = process.env.SAAS_OWNER_EMAIL ?? "saasadmin@example.com";
const SAAS_OWNER_PASSWORD = process.env.SAAS_OWNER_PASSWORD ?? "YourSecurePassword123!";

export interface TenantSeed {
  tenantId: string;
  ownerEmail: string;
  ownerPassword: string;
  slug: string;
}

/**
 * Login as the SaaS owner and return an authenticated request context.
 * Cached for the run.
 */
let saasCtx: APIRequestContext | null = null;
let saasToken: string | null = null;

export async function getSaaSContext(): Promise<APIRequestContext> {
  if (saasCtx) return saasCtx;
  const ctx = await request.newContext({ baseURL: TEST_API_URL });
  const res = await ctx.post("/auth/login", {
    data: { email: SAAS_OWNER_EMAIL, password: SAAS_OWNER_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(
      `SaaS owner login failed (${res.status()}): ${await res.text()}`,
    );
  }
  const body = await res.json();
  saasToken = body.tokens?.accessToken ?? body.accessToken;
  saasCtx = ctx;
  return ctx;
}

function authHeaders(): Record<string, string> {
  if (!saasToken) throw new Error("SaaS owner not logged in");
  return { Authorization: `Bearer ${saasToken}` };
}

/**
 * Create a tenant through the SaaS endpoint, optionally overriding the plan
 * and subscriptionStatus. Returns credentials the frontend can use to log in.
 */
export async function seedTenant(opts: {
  name: string;
  slug: string;
  plan?: "esencial" | "pro" | "empresa";
  status?: "active" | "trialing" | "cancelled";
  maxLocations?: number;
  trialDaysRemaining?: number;
  cancelled?: boolean;
}): Promise<TenantSeed> {
  const ctx = await getSaaSContext();
  const password = "Test1234!";
  const ownerEmail = `owner-${opts.slug}@e2e.test`;
  const body: Record<string, unknown> = {
    name: opts.name,
    slug: opts.slug,
    plan: opts.plan ?? "esencial",
    ownerEmail,
    ownerPassword: password,
    ownerFirstName: "Test",
    ownerLastName: opts.slug,
  };
  if (opts.status) body.subscriptionStatus = opts.status;

  const res = await ctx.post("/saas/tenants", {
    headers: authHeaders(),
    data: body,
  });
  if (!res.ok()) {
    throw new Error(
      `Failed to seed tenant ${opts.slug} (${res.status()}): ${await res.text()}`,
    );
  }
  const created = await res.json();
  const tenantId: string = created.id ?? created.tenant?.id;

  const patch: Record<string, unknown> = {};
  if (opts.plan) patch.plan = opts.plan;
  if (opts.status) patch.subscriptionStatus = opts.status;
  if (opts.maxLocations) patch.maxLocations = opts.maxLocations;
  if (opts.trialDaysRemaining !== undefined) {
    const d = new Date();
    d.setDate(d.getDate() + opts.trialDaysRemaining);
    patch.trialEnd = d.toISOString();
  }
  if (opts.cancelled) {
    patch.cancelledAt = new Date().toISOString();
    const d = new Date();
    d.setDate(d.getDate() + 30);
    patch.readOnlyUntil = d.toISOString();
  }
  if (Object.keys(patch).length) {
    const patchRes = await ctx.patch(`/saas/tenants/${tenantId}`, {
      headers: authHeaders(),
      data: patch,
    });
    if (!patchRes.ok()) {
      throw new Error(
        `Failed to patch tenant ${opts.slug} (${patchRes.status()}): ${await patchRes.text()}`,
      );
    }
  }

  return {
    tenantId,
    ownerEmail,
    ownerPassword: password,
    slug: opts.slug,
  };
}

/** Log in via the API and store tokens in localStorage via the page. */
export async function loginAs(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  const res = await page.request.post("/auth/login", {
    baseURL: TEST_API_URL,
    data: { email, password },
  });
  if (!res.ok()) {
    throw new Error(
      `Login failed for ${email} (${res.status()}): ${await res.text()}`,
    );
  }
  const body = await res.json();
  const access = body.tokens?.accessToken ?? body.accessToken;
  const refresh = body.tokens?.refreshToken ?? body.refreshToken;
  await page.addInitScript(
    ({ access, refresh }) => {
      localStorage.setItem("kira_auth_token", access);
      localStorage.setItem("kira_refresh_token", refresh);
    },
    { access, refresh },
  );
}

export function uniqueSlug(prefix: string): string {
  return (
    prefix +
    "-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 6)
  );
}