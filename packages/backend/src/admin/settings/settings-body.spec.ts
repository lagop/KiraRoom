import { AdminSettingsController, ProfessionalCrossBookingDto } from "./settings.controller";
import { bodyMetatype, bodyParser } from "../../common/validation/validated-body.testing";

describe("PATCH /admin/settings/professional-cross-booking body", () => {
  const parse = bodyParser(AdminSettingsController, "updateProfessionalCrossBooking");

  it("is the validated class, not an inline type", () => {
    expect(bodyMetatype(AdminSettingsController, "updateProfessionalCrossBooking")).toBe(ProfessionalCrossBookingDto);
  });

  it("takes a boolean and nothing else", async () => {
    expect(await parse({ allowProfessionalCrossBooking: true, plan: "empresa" })).toEqual({ allowProfessionalCrossBooking: true });
    await expect(parse({ allowProfessionalCrossBooking: "yes" })).rejects.toBeDefined();
    await expect(parse({})).rejects.toBeDefined();
  });
});
