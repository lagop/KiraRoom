import { Controller, ForbiddenException, Get } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "./roles.guard";
import { Public } from "../decorators/public.decorator";
import { Roles, SALON_MANAGERS, SALON_TEAM } from "../decorators/roles.decorator";
import { SignedIn } from "../decorators/signed-in.decorator";
import { SaasOwner } from "../../saas/decorators/saas-owner.decorator";

/**
 * RolesGuard used to let through every route without @Roles, so any
 * session -- a client who booked online included -- could export the client
 * base or grant itself message credits. It now refuses what declares nothing.
 */
@Controller("t")
class Routes {
  @Get("open") @Public() open() {}
  @Get("team") @Roles(...SALON_TEAM) team() {}
  @Get("managers") @Roles(...SALON_MANAGERS) managers() {}
  @Get("me") @SignedIn() me() {}
  @Get("platform") @SaasOwner() platform() {}
  @Get("nothing") nothing() {}
}

@Controller("c")
@Roles(...SALON_MANAGERS)
class ManagersByDefault {
  @Get("a") a() {}
  @Get("b") @Roles(...SALON_TEAM) b() {}
  @Get("c") @Public() c() {}
}

const guard = new RolesGuard(new Reflector());

function call(cls: any, method: string, role?: string): boolean {
  const ctx: any = {
    getType: () => "http",
    getHandler: () => cls.prototype[method],
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ method: "GET", url: `/${method}`, user: role ? { id: "u1", role } : undefined }),
    }),
  };
  return guard.canActivate(ctx);
}

describe("RolesGuard", () => {
  it("refuses a route that declares nobody, even to the owner", () => {
    expect(() => call(Routes, "nothing", "owner")).toThrow(ForbiddenException);
    expect(() => call(Routes, "nothing", "client")).toThrow(ForbiddenException);
  });

  it("lets a public route through without a session", () => {
    expect(call(Routes, "open")).toBe(true);
  });

  it("keeps clients and staff out of what only managers may do", () => {
    expect(call(Routes, "managers", "owner")).toBe(true);
    expect(call(Routes, "managers", "admin")).toBe(true);
    expect(call(Routes, "managers", "staff")).toBe(false);
    expect(call(Routes, "managers", "client")).toBe(false);
  });

  it("lets staff use the day-to-day routes, but not clients", () => {
    expect(call(Routes, "team", "staff")).toBe(true);
    expect(call(Routes, "team", "client")).toBe(false);
  });

  it("opens @SignedIn routes to any session, clients included", () => {
    expect(call(Routes, "me", "client")).toBe(true);
    expect(call(Routes, "me")).toBe(false);
  });

  it("keeps platform routes for the SaaS owner", () => {
    expect(call(Routes, "platform", "saas_owner")).toBe(true);
    expect(call(Routes, "platform", "owner")).toBe(false);
  });

  it("applies a controller's roles to its routes, and a route's own declaration first", () => {
    expect(call(ManagersByDefault, "a", "staff")).toBe(false);
    expect(call(ManagersByDefault, "b", "staff")).toBe(true);
    expect(call(ManagersByDefault, "c")).toBe(true);
  });

  it("leaves websockets to the gateway", () => {
    const ctx: any = { getType: () => "ws" };
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
