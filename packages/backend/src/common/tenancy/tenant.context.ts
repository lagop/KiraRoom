import { AsyncLocalStorage } from "async_hooks";

/**
 * Per-request tenant context, consumed by the Prisma tenant-scope
 * extension (`tenant-scope.extension.ts`).
 *
 * The store is a MUTABLE object on purpose. `TenantContextMiddleware`
 * opens it at the very start of the request -- before the guards run,
 * so `req.user` does not exist yet -- and `JwtStrategy.validate()`
 * fills it in once the user has been resolved from the database.
 *
 * Default is `bypass: true` (no filtering). That is deliberate:
 *
 *   - Unauthenticated routes (@Public webhooks, the booking widget,
 *     the public salon site) resolve their own tenant and must keep
 *     working exactly as before.
 *   - Schedulers and CLI scripts run outside any request.
 *
 * Every authenticated request DOES pass through `JwtStrategy.validate`
 * (JwtAuthGuard is a global APP_GUARD), so authenticated traffic is
 * always scoped. The extension is a safety net under the explicit
 * `tenantId` filters in the services, not a replacement for them.
 */
export interface TenantStore {
  /** Tenant the current request acts on, or null before auth resolves. */
  tenantId: string | null;
  /** When true the Prisma extension does not filter anything. */
  bypass: boolean;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

export const currentTenantStore = (): TenantStore | undefined =>
  tenantStorage.getStore();

/**
 * Bind the current async context to a tenant. Called by
 * `JwtStrategy.validate()` once the user record is known.
 *
 * `saas_owner` is bound with `bypass: true`: the platform console at
 * `/saas/*` legitimately reads across tenants, and `SaasOwnerGuard`
 * is what authorises it.
 */
export function bindTenant(tenantId: string | null, role?: string): void {
  const store = tenantStorage.getStore();
  if (!store) return;
  store.tenantId = tenantId ?? null;
  store.bypass = !tenantId || role === "saas_owner";
}

/**
 * Run `fn` with tenant filtering disabled. For code that must cross
 * tenants on purpose outside a request (schedulers, migrations,
 * maintenance scripts).
 */
export function runUnscoped<T>(fn: () => T): T {
  return tenantStorage.run({ tenantId: null, bypass: true }, fn);
}

/** Run `fn` scoped to `tenantId`, for schedulers that loop over tenants. */
export function runAsTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run({ tenantId, bypass: false }, fn);
}
