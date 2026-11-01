import { METHOD_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { AnalyticsController } from "./analytics.controller";
import { ROLES_KEY, SALON_MANAGERS } from "../auth/decorators/roles.decorator";

/**
 * Analítica is the owner's and admins' (owner decision 4a). Staff used to
 * get their own figures from the overview and the status counts, under
 * titles that read as the salon's ("Ingresos totales"), and empty widgets
 * where the rest answered 403. Now every route is SALON_MANAGERS, so
 * RolesGuard answers a staff account with a 403 everywhere, and the
 * per-professional filter that served them is gone.
 */

function routes(): string[] {
  const proto = AnalyticsController.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter(
    (name) => name !== "constructor" && Reflect.getMetadata(METHOD_METADATA, proto[name] as object) !== undefined,
  );
}

function rolesOf(name: string): UserRole[] | undefined {
  const handler = (AnalyticsController.prototype as unknown as Record<string, object>)[name];
  return Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, AnalyticsController);
}

describe("Analítica is for managers only", () => {
  it("has routes to check", () => {
    expect(routes()).toEqual(
      expect.arrayContaining([
        "getFeatureFlags",
        "getOverview",
        "getAppointmentStatusByDays",
        "getAppointmentRates",
        "getProfessionalPerformance",
        "getClientInsights",
      ]),
    );
  });

  it.each(routes())("%s is owner and admin only: staff get a 403", (name) => {
    const roles = rolesOf(name);
    expect(roles).toEqual(SALON_MANAGERS);
    expect(roles).not.toContain(UserRole.staff);
  });

  it("the controller defaults to managers too, so a new route cannot open to staff by omission", () => {
    expect(Reflect.getMetadata(ROLES_KEY, AnalyticsController)).toEqual(SALON_MANAGERS);
  });

  it("the overview and the status counts are the whole salon's, with no professional filter", async () => {
    const analytics: any = {
      getOverview: jest.fn(async () => ({})),
      getAppointmentStatusByDays: jest.fn(async () => []),
    };
    const flags: any = { clampMonths: async (_t: string, m: number) => m };
    const ctl = new AnalyticsController(analytics, flags);
    const req = { user: { id: "u1", tenantId: "t1", role: "owner", userId: "u1" } } as any;
    await ctl.getOverview(req, "3");
    await ctl.getAppointmentStatusByDays(req, "7");
    expect(analytics.getOverview).toHaveBeenCalledWith("t1", 3);
    expect(analytics.getAppointmentStatusByDays).toHaveBeenCalledWith("t1", 7);
  });
});
