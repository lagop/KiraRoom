import { createHmac } from "crypto";
import { HttpException } from "@nestjs/common";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { WebhooksController } from "./webhooks.controller";

/**
 * POST /webhooks/sms/twilio -- Twilio's SMS status callback.
 *
 * It was public and wrote whatever it was sent into notification_deliveries.
 * Now only a request carrying a valid X-Twilio-Signature is processed. The
 * signature is computed here from Twilio's documented scheme (HMAC-SHA1 of
 * the URL followed by the POST parameters sorted by name, base64), not with
 * the SDK the controller uses, so a mistake in how the controller calls the
 * SDK would show.
 */
describe("WebhooksController (Twilio)", () => {
  const authToken = "fictitious_twilio_auth_token_0001";
  const params = {
    MessageSid: "SM00000000000000000000000000000001",
    MessageStatus: "delivered",
    To: "+34600000000",
    AccountSid: "AC00000000000000000000000000000000",
  };

  function twilioSignature(url: string, body: Record<string, string>, token = authToken) {
    const data = Object.keys(body)
      .sort()
      .reduce((acc, k) => acc + k + body[k], url);
    return createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  }

  function build(env: Record<string, string | undefined> = { TWILIO_AUTH_TOKEN: authToken }) {
    const prisma: any = { notificationDelivery: { upsert: jest.fn().mockResolvedValue({}) } };
    const config: any = { get: (k: string) => env[k] };
    const controller = new WebhooksController(prisma, config);
    (controller as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return { controller, prisma };
  }

  /** What Express hands the controller behind Traefik. */
  function request(body: Record<string, string>) {
    return {
      body,
      originalUrl: "/api/v1/webhooks/sms/twilio",
      protocol: "https",
      get: (h: string) => (h.toLowerCase() === "host" ? "api.kiraroom.example.test" : undefined),
    } as any;
  }

  async function status(p: Promise<unknown>): Promise<number> {
    try {
      await p;
      return 200;
    } catch (e) {
      return (e as HttpException).getStatus();
    }
  }

  it("is public, so Twilio can reach it", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WebhooksController.prototype.handleTwilioWebhook)).toBe(true);
  });

  it("processes a callback signed for the public URL", async () => {
    const { controller, prisma } = build();
    const sig = twilioSignature("https://api.kiraroom.example.test/api/v1/webhooks/sms/twilio", params);
    await expect(controller.handleTwilioWebhook(params, sig, request(params))).resolves.toEqual({ received: true });
    expect(prisma.notificationDelivery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalId: params.MessageSid } }),
    );
  });

  it("uses API_BASE_URL when the proxy's host differs from the public one", async () => {
    const { controller, prisma } = build({ TWILIO_AUTH_TOKEN: authToken, API_BASE_URL: "https://api.public.example.test/" });
    const sig = twilioSignature("https://api.public.example.test/api/v1/webhooks/sms/twilio", params);
    await controller.handleTwilioWebhook(params, sig, request(params));
    expect(prisma.notificationDelivery.upsert).toHaveBeenCalled();
  });

  it("rejects a request without signature", async () => {
    const { controller, prisma } = build();
    expect(await status(controller.handleTwilioWebhook(params, undefined, request(params)))).toBe(401);
    expect(prisma.notificationDelivery.upsert).not.toHaveBeenCalled();
  });

  it("rejects a signature made with another token", async () => {
    const { controller, prisma } = build();
    const sig = twilioSignature("https://api.kiraroom.example.test/api/v1/webhooks/sms/twilio", params, "other_token");
    expect(await status(controller.handleTwilioWebhook(params, sig, request(params)))).toBe(401);
    expect(prisma.notificationDelivery.upsert).not.toHaveBeenCalled();
  });

  it("rejects a signed callback whose parameters were changed", async () => {
    const { controller, prisma } = build();
    const sig = twilioSignature("https://api.kiraroom.example.test/api/v1/webhooks/sms/twilio", params);
    const altered = { ...params, MessageStatus: "failed" };
    expect(await status(controller.handleTwilioWebhook(altered, sig, request(altered)))).toBe(401);
    expect(prisma.notificationDelivery.upsert).not.toHaveBeenCalled();
  });

  it("refuses with 503 while TWILIO_AUTH_TOKEN is not set", async () => {
    const { controller, prisma } = build({});
    const sig = twilioSignature("https://api.kiraroom.example.test/api/v1/webhooks/sms/twilio", params);
    expect(await status(controller.handleTwilioWebhook(params, sig, request(params)))).toBe(503);
    expect(prisma.notificationDelivery.upsert).not.toHaveBeenCalled();
  });

  it("no longer exposes the old unsigned Resend route", () => {
    expect((WebhooksController.prototype as any).handleResendWebhook).toBeUndefined();
  });
});
