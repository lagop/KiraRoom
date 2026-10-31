import { BadRequestException } from "@nestjs/common";
import { createHmac } from "crypto";
import { RebookingController } from "./rebooking.controller";

/**
 * Links in rebooking reminders sent before the shared unsubscribe link:
 * ".../api/public/rebooking/opt-out?token=…&client=…" on the web app, which
 * answered 404. The web app forwards them to GET /rebooking/public/opt-out,
 * which only redirects (a mail scanner must not unsubscribe anyone).
 */
describe("RebookingController legacy opt-out link", () => {
  const ORIGINAL_ENV = process.env;
  const SECRET = "legacy-secret-of-enough-length";
  const sign = (clientId: string) => createHmac("sha256", SECRET).update(clientId).digest("hex").slice(0, 32);

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, REBOOKING_OPT_OUT_SECRET: SECRET };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  function setup() {
    const cadence: any = { optOutClient: jest.fn().mockResolvedValue(undefined) };
    const unsubscribes: any = {
      link: jest.fn(({ id }: { id: string }) => ({ pageUrl: `https://app.test/public/baja/signed-${id}`, headers: {} })),
      pageUrl: jest.fn((token: string) => `https://app.test/public/baja/${token}`),
      tokenFor: jest.fn(({ id }: { id: string }) => `signed-${id}`),
      unsubscribe: jest.fn().mockResolvedValue({ salonName: "Salón", unsubscribed: true }),
    };
    const controller = new RebookingController(cadence, {} as any, {} as any, unsubscribes);
    return { controller, cadence, unsubscribes };
  }

  it("GET with a valid old link redirects to that client's unsubscribe page, and changes nothing", () => {
    const { controller, cadence, unsubscribes } = setup();
    expect(controller.legacyOptOutPage(sign("cli-1"), "cli-1")).toEqual({
      url: "https://app.test/public/baja/signed-cli-1",
      statusCode: 302,
    });
    expect(unsubscribes.link).toHaveBeenCalledWith({ kind: "c", id: "cli-1" });
    expect(unsubscribes.unsubscribe).not.toHaveBeenCalled();
    expect(cadence.optOutClient).not.toHaveBeenCalled();
  });

  it("GET with a forged, altered or missing token lands on the page's 'not valid' answer", () => {
    const { controller, unsubscribes } = setup();
    for (const [token, client] of [
      [sign("cli-1"), "cli-2"],
      ["0".repeat(32), "cli-1"],
      [undefined, "cli-1"],
      [sign("cli-1"), undefined],
    ] as Array<[any, any]>) {
      expect(controller.legacyOptOutPage(token, client)).toEqual({
        url: "https://app.test/public/baja/invalido",
        statusCode: 302,
      });
    }
    expect(unsubscribes.link).not.toHaveBeenCalled();
  });

  it("GET refuses every old link in production when the old secret is gone", () => {
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "production" };
    delete process.env.REBOOKING_OPT_OUT_SECRET;
    const { controller } = setup();
    expect(controller.legacyOptOutPage(sign("cli-1"), "cli-1").url).toBe("https://app.test/public/baja/invalido");
  });

  it("POST with a valid old link does what the shared unsubscribe does", async () => {
    const { controller, unsubscribes } = setup();
    await expect(controller.publicOptOut(sign("cli-1"), "cli-1")).resolves.toEqual({ ok: true });
    expect(unsubscribes.unsubscribe).toHaveBeenCalledWith("signed-cli-1");
  });

  it("POST for a client without email still stops the rebooking reminders", async () => {
    const { controller, unsubscribes, cadence } = setup();
    unsubscribes.unsubscribe.mockRejectedValueOnce(new Error("no email"));
    await controller.publicOptOut(sign("cli-1"), "cli-1");
    expect(cadence.optOutClient).toHaveBeenCalledWith("cli-1");
  });

  it("POST with a bad token is refused", async () => {
    const { controller, unsubscribes } = setup();
    await expect(controller.publicOptOut(sign("cli-1"), "cli-2")).rejects.toBeInstanceOf(BadRequestException);
    expect(unsubscribes.unsubscribe).not.toHaveBeenCalled();
  });
});
