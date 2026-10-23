import { Reflector } from "@nestjs/core";
import { PATH_METADATA } from "@nestjs/common/constants";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { MessageBundlesController } from "../../message-bundles/message-bundles.controller";
import { TenantAddOnsController } from "./tenant-addons.controller";

/**
 * The billing page asked for the salon's message credits at
 * /message-bundles/tenants/current/balance. That is the SaaS-admin route
 * (`tenants/:tenantId/balance`, with "current" as the tenant id), so every
 * salon got "Forbidden resource". The salon's own route is
 * /payments/message-bundles/tenants/current/balance; these pin both so the
 * two can't be confused again.
 */

const guard = new RolesGuard(new Reflector());

function allowed(cls: any, method: string, role: string): boolean {
  const ctx: any = {
    getType: () => "http",
    getHandler: () => cls.prototype[method],
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ method: "GET", url: `/${method}`, user: { id: "u1", role, tenantId: "t-1" } }),
    }),
  };
  return guard.canActivate(ctx);
}

describe("message credit balance", () => {
  it("the salon's route is /payments/message-bundles/tenants/current/balance", () => {
    expect(Reflect.getMetadata(PATH_METADATA, TenantAddOnsController)).toBe("payments");
    expect(Reflect.getMetadata(PATH_METADATA, TenantAddOnsController.prototype.balance)).toBe(
      "message-bundles/tenants/current/balance",
    );
  });

  it("is open to the owner and the admin, also during the trial", () => {
    expect(allowed(TenantAddOnsController, "balance", "owner")).toBe(true);
    expect(allowed(TenantAddOnsController, "balance", "admin")).toBe(true);
  });

  it("stays closed to staff and clients", () => {
    expect(allowed(TenantAddOnsController, "balance", "staff")).toBe(false);
    expect(allowed(TenantAddOnsController, "balance", "client")).toBe(false);
  });

  it("the look-alike /message-bundles/tenants/:tenantId/balance is the SaaS admin's only", () => {
    expect(Reflect.getMetadata(PATH_METADATA, MessageBundlesController)).toBe("message-bundles");
    expect(Reflect.getMetadata(PATH_METADATA, MessageBundlesController.prototype.balance)).toBe(
      "tenants/:tenantId/balance",
    );
    expect(allowed(MessageBundlesController, "balance", "owner")).toBe(false);
    expect(allowed(MessageBundlesController, "balance", "saas_owner")).toBe(true);
  });

  it("reads the balance of the tenant in the token, never one from the URL", async () => {
    const bundles = {
      getBalance: jest.fn().mockResolvedValue({
        creditsRemaining: 0,
        creditsPurchasedTotal: 0,
        creditsUsedTotal: 0,
        lastTopupAt: null,
      }),
    };
    const controller = new TenantAddOnsController({} as any, {} as any, {} as any, bundles as any);

    const out = await controller.balance({ user: { id: "u1", role: "owner", tenantId: "t-1" } });

    expect(bundles.getBalance).toHaveBeenCalledWith("t-1");
    expect(out.creditsRemaining).toBe(0);
  });
});
