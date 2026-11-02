import { GoneException } from "@nestjs/common";
import { WhatsAppController, WHATSAPP_OAUTH_UNAVAILABLE } from "./whatsapp.controller";

/**
 * B10: "Conectar con Meta" (OAuth) saved only the token, with no WhatsApp
 * Business account or number, and the page said "Conectado" while nothing
 * could be sent. The panel no longer offers it; its routes stay but answer
 * 410 in Spanish, so it cannot be used half-working. The manual connection
 * is untouched.
 */
describe("WhatsApp OAuth is switched off", () => {
  const whatsapp = {
    buildConnectUrl: jest.fn(() => "https://example.invalid/oauth"),
    completeOAuth: jest.fn(),
    manualConnect: jest.fn(async () => ({ connected: true })),
  };
  const controller = new WhatsAppController(whatsapp as any, { get: jest.fn() } as any);
  const req = { user: { id: "u1", tenantId: "t1", role: "owner" } } as any;
  const res = { json: jest.fn() } as any;

  it("connect/start answers 410 in Spanish and hands out no URL", () => {
    let err: unknown;
    try {
      controller.start(req, res);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GoneException);
    expect((err as GoneException).getStatus()).toBe(410);
    expect((err as GoneException).message).toBe(WHATSAPP_OAUTH_UNAVAILABLE);
    expect(WHATSAPP_OAUTH_UNAVAILABLE).toMatch(/no está disponible todavía/);
    expect(whatsapp.buildConnectUrl).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("connect/callback answers 410 too and connects nothing", async () => {
    await expect(controller.callback("code", "state")).rejects.toBeInstanceOf(GoneException);
    expect(whatsapp.completeOAuth).not.toHaveBeenCalled();
  });

  it("the manual connection still works", async () => {
    await controller.manual(req, { accessToken: "x", wabaId: "1", phoneNumberId: "2", displayPhone: "+34600000000" });
    expect(whatsapp.manualConnect).toHaveBeenCalledWith("t1", expect.objectContaining({ wabaId: "1" }));
  });
});
