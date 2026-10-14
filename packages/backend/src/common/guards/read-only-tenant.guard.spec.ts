import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ReadOnlyTenantGuard } from "./read-only-tenant.guard";
import { ALLOW_WHEN_READ_ONLY } from "../decorators/allow-when-read-only.decorator";

/**
 * A salon whose trial ended without a plan, or whose subscription was
 * cancelled or suspended, may sign in, read, export and pay, but not write.
 * Before this guard only @Feature routes were read-only, so the agenda,
 * clients and services stayed fully writable.
 */
function ctx(opts: { method?: string; user?: any; allowed?: boolean }) {
  const handler = () => undefined;
  if (opts.allowed) Reflect.defineMetadata(ALLOW_WHEN_READ_ONLY, true, handler);
  return {
    getType: () => "http",
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ method: opts.method ?? "POST", user: opts.user }) }),
  } as unknown as ExecutionContext;
}

const guard = new ReadOnlyTenantGuard(new Reflector());
const owner = (subscriptionStatus: string) => ({ tenantId: "t1", role: "owner", subscriptionStatus });

describe("ReadOnlyTenantGuard", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses a %s from a cancelled salon", (method) => {
    expect(() => guard.canActivate(ctx({ method, user: owner("cancelled") }))).toThrow(ForbiddenException);
  });

  it("tells cancelled and suspended apart, and points to billing", () => {
    for (const status of ["cancelled", "suspended"]) {
      try {
        guard.canActivate(ctx({ user: owner(status) }));
        throw new Error("not refused");
      } catch (e: any) {
        expect(e.getResponse()).toMatchObject({
          code: status === "cancelled" ? "SUBSCRIPTION_CANCELLED" : "SUBSCRIPTION_SUSPENDED",
          reactivateUrl: "/dashboard/billing",
          exportAvailable: true,
        });
      }
    }
  });

  it("lets reads through: the salon can still look and export", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(guard.canActivate(ctx({ method, user: owner("cancelled") }))).toBe(true);
    }
  });

  it("lets through the routes marked @AllowWhenReadOnly (pay, sign out)", () => {
    expect(guard.canActivate(ctx({ user: owner("suspended"), allowed: true }))).toBe(true);
  });

  it("does not touch salons in trial or with a plan", () => {
    for (const status of ["trialing", "active", "past_due"]) {
      expect(guard.canActivate(ctx({ user: owner(status) }))).toBe(true);
    }
  });

  it("leaves public routes, the salon's clients and the platform owner alone", () => {
    expect(guard.canActivate(ctx({ user: undefined }))).toBe(true);
    expect(guard.canActivate(ctx({ user: { tenantId: "t1", role: "client" } }))).toBe(true);
    expect(guard.canActivate(ctx({ user: { tenantId: "t1", role: "saas_owner", subscriptionStatus: "cancelled" } }))).toBe(true);
  });
});
