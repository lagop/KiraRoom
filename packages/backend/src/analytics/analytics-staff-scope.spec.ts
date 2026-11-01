import { ForbiddenException } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";

/**
 * A professional's own login sees their own figures. A staff account linked
 * to no professional got `null` for "which professional" -- read as "no
 * filter" -- and so saw the whole salon's. Now it is refused, as clients and
 * appointments are for such an account.
 */

function setup(professional: { id: string } | null) {
  const analytics: any = {
    getOverview: jest.fn(async () => ({})),
    getAppointmentStatusByDays: jest.fn(async () => []),
  };
  const flags: any = { clampMonths: (_p: string, m: number) => m };
  const professionals: any = { getProfessionalByUserId: jest.fn(async () => professional) };
  return { ctl: new AnalyticsController(analytics, flags, professionals), analytics };
}

const req = (role: string) => ({ user: { id: "u1", tenantId: "t1", role, userId: "u1" } }) as any;

describe("analytics for staff", () => {
  it("a professional gets their own overview and status counts", async () => {
    const { ctl, analytics } = setup({ id: "p-ana" });
    await ctl.getOverview(req("staff"), "3");
    await ctl.getAppointmentStatusByDays(req("staff"), "7");
    expect(analytics.getOverview).toHaveBeenCalledWith("t1", 3, "p-ana");
    expect(analytics.getAppointmentStatusByDays).toHaveBeenCalledWith("t1", 7, "p-ana");
  });

  it("a staff account linked to no professional gets a 403, not the whole salon", async () => {
    const { ctl, analytics } = setup(null);
    await expect(ctl.getOverview(req("staff"), "3")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.getAppointmentStatusByDays(req("staff"), "7")).rejects.toBeInstanceOf(ForbiddenException);
    expect(analytics.getOverview).not.toHaveBeenCalled();
    expect(analytics.getAppointmentStatusByDays).not.toHaveBeenCalled();
  });

  it("the owner sees the whole salon", async () => {
    const { ctl, analytics } = setup(null);
    await ctl.getOverview(req("owner"), "3");
    expect(analytics.getOverview).toHaveBeenCalledWith("t1", 3, null);
  });
});
