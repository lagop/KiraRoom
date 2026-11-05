import { WidgetController } from "./widget.controller";
import { CreateWidgetDto, UpdateWidgetDto } from "./widget.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

describe("widget bodies", () => {
  const create = bodyParser(WidgetController, "create");
  const update = bodyParser(WidgetController, "update");

  it("are classes with validators (they had none: every field was stripped)", async () => {
    expect(bodyMetatype(WidgetController, "create")).toBe(CreateWidgetDto);
    expect(bodyMetatype(WidgetController, "update")).toBe(UpdateWidgetDto);
    // What app/dashboard/settings/widget/page.tsx sends.
    const body = { name: "Landing principal", allowedOrigins: ["https://misalon.com", "https://misalon.es"] };
    expect(await create(body)).toEqual(body);
  });

  it("tidies pasted origins", async () => {
    const out = await create({ name: "W", allowedOrigins: [" https://misalon.com/ ", "https://*.misalon.es"] });
    expect(out.allowedOrigins).toEqual(["https://misalon.com", "https://*.misalon.es"]);
  });

  it("refuses origins that would add CSP directives to the embed's header", async () => {
    for (const origin of [
      "https://misalon.com; script-src *",
      "https://a.com https://evil.com",
      "javascript:alert(1)",
      "misalon.com",
      "https://misalon.com/path",
    ]) {
      await expect(create({ name: "W", allowedOrigins: [origin] })).rejects.toBeDefined();
    }
  });

  it("takes ids for services and professionals, and drops the token and tenant", async () => {
    const out = await update({ services: [uuid(1)], professionals: [uuid(2)], token: "x", tenantId: uuid(3) });
    expect(out).toEqual({ services: [uuid(1)], professionals: [uuid(2)] });
    await expect(update({ services: ["svc"] })).rejects.toBeDefined();
    await expect(update({ theme: "dark" })).rejects.toBeDefined();
  });
});
