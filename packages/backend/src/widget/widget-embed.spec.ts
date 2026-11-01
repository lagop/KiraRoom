import { WidgetService } from "./widget.service";
import { EmbedController, WidgetController } from "./widget.controller";
import { frameAncestorOrigins } from "./frame-origins";
import { bodyParser } from "../common/validation/validated-body.testing";

/**
 * The embed code the panel shows must work: the list gives the whole token
 * (it was cut to six characters, so every snippet 404ed), and the sites a
 * salon allows are valid https origins only, served for the embed page's
 * frame-ancestors header without ever adding a directive to it.
 */
describe("widget embed", () => {
  const token = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

  it("lists widgets with the whole token", async () => {
    const prisma: any = {
      widgetInstance: { findMany: jest.fn(async () => [{ id: "w1", token, name: "Web" }]) },
    };
    const list = await new WidgetService(prisma).list("t1");
    expect(list[0].token).toBe(token);
    expect(prisma.widgetInstance.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });

  it("keeps only valid https origins from a stored list", () => {
    expect(
      frameAncestorOrigins([
        "https://MiSalon.com/",
        "https://*.misalon.es",
        "https://misalon.com",
        "http://misalon.org",
        "https://misalon.com; script-src *",
        "https://a.com https://b.com",
        "https://misalon.com/reservas",
        "*",
        "'self'",
        42,
      ]),
    ).toEqual(["https://misalon.com", "https://*.misalon.es"]);
    expect(frameAncestorOrigins(null)).toEqual([]);
  });

  it("serves the allowed origins without counting a use", async () => {
    const prisma: any = {
      widgetInstance: {
        findUnique: jest.fn(async () => ({ allowedOrigins: ["https://misalon.com", "http://old.test"] })),
        update: jest.fn(),
      },
    };
    const out = await new EmbedController(new WidgetService(prisma)).frameAncestors(token);
    expect(out).toEqual({ allowedOrigins: ["https://misalon.com"], restricted: true });
    expect(prisma.widgetInstance.update).not.toHaveBeenCalled();
  });

  it("an empty list is unrestricted", async () => {
    const prisma: any = { widgetInstance: { findUnique: jest.fn(async () => ({ allowedOrigins: [] })) } };
    expect(await new WidgetService(prisma).frameAncestors(token)).toEqual({ allowedOrigins: [], restricted: false });
  });

  it("refuses http origins when saving", async () => {
    const create = bodyParser(WidgetController, "create");
    await expect(create({ name: "W", allowedOrigins: ["http://misalon.com"] })).rejects.toBeDefined();
    await expect(create({ name: "W", allowedOrigins: ["HTTPS://MiSalon.com/"] })).resolves.toMatchObject({
      allowedOrigins: ["https://misalon.com"],
    });
  });
});
