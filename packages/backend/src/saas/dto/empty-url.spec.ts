import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateTenantDto } from "./update-tenant.dto";
import { CreateTenantDto } from "./create-tenant.dto";

/**
 * An empty string on an optional URL field must not fail validation.
 *
 * `@IsOptional()` skips validation only for `undefined` and `null`. An empty
 * string is a value, so `@IsUrl()` rejected it — and every HTML form produces
 * empty strings.
 *
 * The owner console's tenant editor hydrates with `website: tenant.website ||
 * ""` and submits the whole object, so editing a tenant with no website sent
 * `website: ""` and the request failed with 400. A newly signed-up salon has no
 * website, no logo and no cover image, which meant **no new tenant could be
 * edited from the console at all** — every save failed on fields the operator
 * had never touched.
 *
 * Reproduced from production: three consecutive `PATCH /saas/tenants/:id`
 * attempts to change one timezone, all 400, at 16:49:14, 16:49:43 and 17:01:48.
 */

const FORM_PAYLOAD_FROM_A_NEW_SALON = {
  name: "ZZ Salon de Prueba",
  description: "",
  email: "",
  phone: "630000000",
  website: "",
  country: "ES",
  timezone: "Atlantic/Canary",
  currency: "EUR",
  plan: "esencial",
  subscriptionStatus: "trialing",
};

describe("optional URL fields tolerate an empty string", () => {
  it("accepts the payload the console actually sends", async () => {
    // This is the exact shape that produced the three 400s.
    const dto = plainToInstance(UpdateTenantDto, FORM_PAYLOAD_FROM_A_NEW_SALON);

    const errors = await validate(dto);

    expect(errors.map((e) => e.property)).toEqual([]);
  });

  it("keeps the timezone that was being saved", async () => {
    const dto = plainToInstance(UpdateTenantDto, FORM_PAYLOAD_FROM_A_NEW_SALON);

    expect(dto.timezone).toBe("Atlantic/Canary");
  });

  it("drops an empty website rather than storing it", async () => {
    const dto = plainToInstance(UpdateTenantDto, { website: "" });

    expect(dto.website).toBeUndefined();
  });

  it("drops a whitespace-only value too", async () => {
    const dto = plainToInstance(UpdateTenantDto, { logo: "   " });

    expect(dto.logo).toBeUndefined();
  });

  it("still rejects a value that is present and not a URL", async () => {
    // The validation has to keep doing its job: this is a typo, not a blank.
    const dto = plainToInstance(UpdateTenantDto, { website: "not a url" });

    const errors = await validate(dto);

    expect(errors.map((e) => e.property)).toEqual(["website"]);
  });

  it("accepts a real URL", async () => {
    const dto = plainToInstance(UpdateTenantDto, {
      website: "https://salon.example",
      logo: "https://salon.example/logo.png",
      coverImage: "https://salon.example/cover.jpg",
    });

    const errors = await validate(dto);

    expect(errors.map((e) => e.property)).toEqual([]);
  });

  it("leaves null alone, so a field can be cleared on purpose", async () => {
    const dto = plainToInstance(UpdateTenantDto, { website: null });

    expect(dto.website).toBeNull();
    expect(await validate(dto)).toEqual([]);
  });

  it("applies to CreateTenantDto as well", async () => {
    // Same three URL fields, same form, same bug waiting.
    const dto = plainToInstance(CreateTenantDto, {
      name: "Nuevo salón",
      slug: "nuevo-salon",
      ownerEmail: "owner@salon.test",
      ownerFirstName: "Dueña",
      ownerLastName: "Prueba",
      website: "",
      logo: "",
      coverImage: "",
    });

    const errors = await validate(dto);

    expect(errors.map((e) => e.property)).not.toContain("website");
    expect(errors.map((e) => e.property)).not.toContain("logo");
    expect(errors.map((e) => e.property)).not.toContain("coverImage");
  });

  it("does not blank a plain string field, which may legitimately be empty", async () => {
    // `description: ""` means "no description", not "not sent". Only the URL
    // fields carry the transform.
    const dto = plainToInstance(UpdateTenantDto, { description: "" });

    expect(dto.description).toBe("");
  });
});
