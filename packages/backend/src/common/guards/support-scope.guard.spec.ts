import * as fs from "fs";
import * as path from "path";
import { ForbiddenException, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { SupportScopeGuard } from "./support-scope.guard";
import { SUPPORT_MODE_REFUSAL } from "../decorators/not-during-support.decorator";

/**
 * Audit 8 D1: walks every route of every controller and asserts which ones
 * a support session (the platform owner inside a salon) is refused. A new
 * route that pays, touches fiscal data, passwords, 2FA, exports or deletes
 * the salon must be added here AND marked @NotDuringSupport(); a route that
 * shows up here unexpectedly fails the test too.
 */
const BLOCKED_DURING_SUPPORT = [
  // Plan, payments, add-ons and packs
  "POST /payments/subscription/checkout",
  "POST /payments/subscription/change-plan",
  "POST /payments/subscription/cancel",
  "POST /payments/subscription/undo-cancel",
  "POST /payments/subscription/reactivate",
  "POST /payments/subscription/billing-portal",
  "POST /payments/subscription/update-locations",
  "PATCH /payments/stripe/settings",
  "POST /payments/connect/onboarding",
  "PATCH /payments/connect/settings",
  "POST /payments/tenants/current/add-ons/:key",
  "DELETE /payments/tenants/current/add-ons/:key",
  "POST /payments/message-bundles/tenants/current/topup",
  "POST /email-campaigns/quota/pack-checkout",
  // Fiscal data, certificates, accounting
  "PATCH /invoices/settings/fiscal",
  "POST /invoices/certificates",
  "PATCH /invoices/certificates/:id/deactivate",
  "POST /accounting/holded/connect",
  "POST /accounting/disconnect",
  "GET /accounting/export/facturas-emitidas",
  // Passwords, access, 2FA, terms, the owner's own email
  "PATCH /auth/password",
  "POST /auth/2fa/setup",
  "POST /auth/2fa/enable",
  "POST /auth/2fa/disable",
  "POST /auth/2fa/recovery-codes",
  "POST /auth/terms/accept",
  "POST /auth/resend-verification",
  "PATCH /admin/professionals/:id/password",
  "POST /admin/professionals/:id/access",
  "DELETE /admin/professionals/:id/access",
  // The owner's choice whether support may come in
  "PATCH /settings/support-access",
  // Client exports and GDPR
  "GET /admin/clients/:id/export",
  "POST /admin/clients/:id/anonymize",
  "GET /exports/clients.csv",
  "GET /exports/clients.xlsx",
  "GET /exports/appointments.csv",
  "GET /exports/appointments.xlsx",
  "GET /exports/payments.csv",
  "GET /exports/payments.xlsx",
  "GET /exports/services.csv",
  "GET /exports/services.xlsx",
  "GET /exports/professionals.csv",
  "GET /exports/professionals.xlsx",
  "GET /exports/wallet-transactions.csv",
  "GET /exports/wallet-transactions.xlsx",
  "GET /exports/gift-cards.csv",
  "GET /exports/gift-cards.xlsx",
  // Deleting the salon, the once-only web address
  "POST /settings/salon-deletion",
  "DELETE /settings/salon-deletion",
  "PATCH /web-address",
];

interface Route {
  key: string;
  handler: (...args: any[]) => any;
  controller: new (...args: any[]) => any;
}

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...controllerFiles(full));
    else if (entry.name.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

function join(...parts: string[]): string {
  return ("/" + parts.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")) || "/";
}

function allRoutes(): Route[] {
  const routes: Route[] = [];
  const src = path.resolve(__dirname, "..", "..");
  for (const file of controllerFiles(src)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    for (const exported of Object.values(mod)) {
      if (typeof exported !== "function") continue;
      const base = Reflect.getMetadata(PATH_METADATA, exported);
      if (base === undefined) continue;
      const controller = exported as Route["controller"];
      const proto = controller.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        // The descriptor, not proto[name]: that would run a getter on the bare prototype.
        const handler = Object.getOwnPropertyDescriptor(proto, name)?.value;
        if (typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        if (method === undefined || sub === undefined) continue;
        const bases: string[] = Array.isArray(base) ? base : [base];
        const subs: string[] = Array.isArray(sub) ? sub : [sub];
        for (const b of bases) {
          for (const s of subs) {
            routes.push({ key: `${RequestMethod[method]} ${join(b, s)}`, handler, controller });
          }
        }
      }
    }
  }
  return routes;
}

function contextFor(route: Route, user: Record<string, unknown> | undefined) {
  return {
    getType: () => "http",
    getHandler: () => route.handler,
    getClass: () => route.controller,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

describe("SupportScopeGuard: what a support session may not do (audit 8 D1)", () => {
  const guard = new SupportScopeGuard(new Reflector());
  let routes: Route[] = [];
  beforeAll(() => {
    routes = allRoutes();
  }, 120_000);
  const support = { id: "owner-1", role: "owner", tenantId: "t1", impersonatedBy: "saas-1" };
  const owner = { id: "owner-1", role: "owner", tenantId: "t1" };

  function refusedDuringSupport(route: Route): boolean {
    try {
      guard.canActivate(contextFor(route, support));
      return false;
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenException);
      expect((e as ForbiddenException).getResponse()).toEqual({ code: "SUPPORT_MODE", message: SUPPORT_MODE_REFUSAL });
      return true;
    }
  }

  it("finds the app's routes", () => {
    expect(routes.length).toBeGreaterThan(300);
  });

  it("refuses exactly the listed routes under impersonation", () => {
    const blocked = routes.filter(refusedDuringSupport).map((r) => r.key);
    expect([...new Set(blocked)].sort()).toEqual([...BLOCKED_DURING_SUPPORT].sort());
  });

  it("every listed route exists", () => {
    const keys = new Set(routes.map((r) => r.key));
    expect(BLOCKED_DURING_SUPPORT.filter((k) => !keys.has(k))).toEqual([]);
  });

  it("keeps the agenda, services, team and website open to support", () => {
    const open = [
      "POST /appointments",
      "PUT /services/:id",
      "PATCH /appointments/:id",
      "GET /settings/support-access",
      "PATCH /admin/professionals/:id",
      "GET /clients",
      "POST /auth/logout",
    ];
    for (const key of open) {
      const route = routes.find((r) => r.key === key);
      expect({ key, found: !!route }).toEqual({ key, found: true });
      expect(refusedDuringSupport(route!)).toBe(false);
    }
  });

  it("never refuses the salon's own team, nor a request without a user", () => {
    for (const route of routes) {
      expect(guard.canActivate(contextFor(route, owner))).toBe(true);
      expect(guard.canActivate(contextFor(route, undefined))).toBe(true);
    }
  });
});

describe("SupportScopeGuard: writes in a support session leave a trace (audit 2026-11-06)", () => {
  class Controller {
    handler() {}
  }
  const ctx = (method: string, user: any) =>
    ({
      getType: () => "http",
      getHandler: () => Controller.prototype.handler,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => ({ method, route: { path: "/payments/refund/:id" }, url: "/payments/refund/9?x=1", user }) }),
    }) as any;
  const support = { id: "owner-1", role: "owner", tenantId: "t1", impersonatedBy: "saas-1" };

  function setup() {
    const record = jest.fn(async () => ({ id: "a1" }));
    return { record, guard: new SupportScopeGuard(new Reflector(), { record } as any) };
  }

  it("records a write with the route, never the body", () => {
    const { guard, record } = setup();
    expect(guard.canActivate(ctx("POST", support))).toBe(true);
    expect(record).toHaveBeenCalledWith("support.request", {
      actorId: "owner-1",
      actorRole: "owner",
      tenantId: "t1",
      metadata: { method: "POST", route: "/payments/refund/:id" },
    });
  });

  it("records no reads, and nothing for the salon's own team", () => {
    const { guard, record } = setup();
    guard.canActivate(ctx("GET", support));
    guard.canActivate(ctx("POST", { id: "owner-1", role: "owner", tenantId: "t1" }));
    expect(record).not.toHaveBeenCalled();
  });

  it("a failing audit write never fails the request", async () => {
    const guard = new SupportScopeGuard(new Reflector(), { record: jest.fn(async () => Promise.reject(new Error("db down"))) } as any);
    expect(guard.canActivate(ctx("DELETE", support))).toBe(true);
    await new Promise((r) => setImmediate(r));
  });
});
