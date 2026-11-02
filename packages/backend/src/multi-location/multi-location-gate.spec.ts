import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { FEATURE_KEY_METADATA } from "../common/decorators/feature.decorator";
import { MultiLocationController } from "./multi-location.controller";

/**
 * After leaving Empresa (A13): every /locations route answered 403, so a
 * salon could neither see its locations nor close the ones it no longer
 * runs. Reading and closing are now open to every plan; creating, editing
 * (which includes reactivating) and the per-location KPIs stay Empresa.
 */

const featureOf = (name: keyof MultiLocationController) =>
  Reflect.getMetadata(FEATURE_KEY_METADATA, MultiLocationController.prototype[name]) ??
  Reflect.getMetadata(FEATURE_KEY_METADATA, MultiLocationController);
const rolesOf = (name: keyof MultiLocationController) =>
  Reflect.getMetadata(ROLES_KEY, MultiLocationController.prototype[name]);

describe("/locations plan gate", () => {
  it("no class-wide gate", () => {
    expect(Reflect.getMetadata(FEATURE_KEY_METADATA, MultiLocationController)).toBeUndefined();
  });

  it("the list, one location and the deactivation preview are readable on any plan", () => {
    expect(featureOf("list")).toBeUndefined();
    expect(featureOf("get")).toBeUndefined();
    expect(featureOf("deactivationPreview")).toBeUndefined();
  });

  it("closing a location needs no plan, and stays owner-only", () => {
    expect(featureOf("remove")).toBeUndefined();
    expect(rolesOf("remove")).toEqual(["owner"]);
  });

  it("creating, editing and the KPIs stay Empresa", () => {
    expect(featureOf("create")).toBe("multi_location");
    expect(featureOf("update")).toBe("multi_location");
    expect(featureOf("stats")).toBe("multi_location");
  });
});
