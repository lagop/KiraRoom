import { GoneException } from "@nestjs/common";
import { WhatsAppController, WHATSAPP_OAUTH_UNAVAILABLE } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";
import { MetaCloudApiClient } from "./meta-cloud-api.client";

/**
 * B10: "Conectar con Meta" (OAuth) saved only the token, with no WhatsApp
 * Business account or number, and the page said "Conectado" while nothing
 * could be sent. The panel no longer offers it; its routes stay but answer
 * 410 in Spanish, so it cannot be used half-working. The manual connection
 * is untouched.
 *
 * M18: its code is gone too -- a state with no expiry, a "kira-dev"
 * fallback secret and no tie to the session -- so nothing can switch it
 * back on half-fixed. The embedded signup will be built on the channels'
 * state scheme instead.
 */
describe("WhatsApp OAuth is switched off", () => {
  const whatsapp = { manualConnect: jest.fn(async () => ({ connected: true })) };
  const controller = new WhatsAppController(whatsapp as any);
  const req = { user: { id: "u1", tenantId: "t1", role: "owner" } } as any;

  it("connect/start answers 410 in Spanish and hands out no URL", () => {
    let err: unknown;
    try {
      controller.start();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GoneException);
    expect((err as GoneException).getStatus()).toBe(410);
    expect((err as GoneException).message).toBe(WHATSAPP_OAUTH_UNAVAILABLE);
    expect(WHATSAPP_OAUTH_UNAVAILABLE).toMatch(/no está disponible todavía/);
  });

  it("connect/callback answers 410 too and connects nothing", () => {
    expect(() => controller.callback()).toThrow(GoneException);
  });

  it("the OAuth helpers and the unused token bucket are gone", () => {
    for (const name of ["buildConnectUrl", "completeOAuth", "consumeToken"]) {
      expect((WhatsAppService.prototype as any)[name]).toBeUndefined();
    }
    for (const name of ["buildOAuthUrl", "exchangeCodeForToken"]) {
      expect((MetaCloudApiClient.prototype as any)[name]).toBeUndefined();
    }
  });

  it("the manual connection still works", async () => {
    await controller.manual(req, { accessToken: "x", wabaId: "1", phoneNumberId: "2" });
    expect(whatsapp.manualConnect).toHaveBeenCalledWith("t1", expect.objectContaining({ wabaId: "1" }));
  });
});
