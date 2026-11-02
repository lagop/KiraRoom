import { METHOD_METADATA } from "@nestjs/common/constants";
import { TaxReportsController } from "./tax-reports.controller";
import { ROLES_KEY, SALON_MANAGERS } from "../../auth/decorators/roles.decorator";

/**
 * The quarterly drafts (modelo 303/420/130) carry the salon's bases and
 * cuotas: its takings. Staff could list and read them, and the regime
 * behind them, although invoices and analytics hide those figures from
 * staff. Every route is now SALON_MANAGERS (C5).
 */
describe("tax reports are for managers only", () => {
  const proto = TaxReportsController.prototype as unknown as Record<string, object>;
  const routes = Object.getOwnPropertyNames(proto).filter(
    (name) => name !== "constructor" && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined,
  );

  it("has the routes to check", () => {
    expect(routes.sort()).toEqual(["findOne", "generate", "list", "quarterlyType"]);
  });

  it.each(["findOne", "generate", "list", "quarterlyType"])("%s is owner and admin only", (name) => {
    expect(Reflect.getMetadata(ROLES_KEY, proto[name])).toEqual(SALON_MANAGERS);
  });
});
