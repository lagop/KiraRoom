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
  /**
   * Who is signed in on this request, set with the tenant by JwtStrategy.
   * During a support session (impersonation) it says which saas_owner is
   * really acting, so AuditLogService can record them (audit 8, C4).
   */
  actor?: RequestActor;
}

export interface RequestActor {
  userId: string;
  role: string;
  /** The saas_owner acting as this user in a support session. */
  impersonatedBy?: string;
  impersonationId?: string;
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

/** Records who the request is signed in as (JwtStrategy, after bindTenant). */
export function bindActor(actor: RequestActor): void {
  const store = tenantStorage.getStore();
  if (!store) return;
  store.actor = actor;
}

/** The signed-in actor of the current request, if any. */
export const currentRequestActor = (): RequestActor | undefined => tenantStorage.getStore()?.actor;

/**
 * Run `fn` with tenant filtering disabled. For code that must cross
 * tenants on purpose outside a request (schedulers, migrations,
 * maintenance scripts).
 */
export function runUnscoped<T>(fn: () => T): T {
  // The request's actor goes along: an audit row written inside still names them.
  return tenantStorage.run({ tenantId: null, bypass: true, actor: tenantStorage.getStore()?.actor }, fn);
}

/** Run `fn` scoped to `tenantId`, for schedulers that loop over tenants. */
export function runAsTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run({ tenantId, bypass: false, actor: tenantStorage.getStore()?.actor }, fn);
}
