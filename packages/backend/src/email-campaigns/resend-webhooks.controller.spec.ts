import { HttpException } from "@nestjs/common";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { signSvixPayload } from "../common/webhooks/svix-signature";
import { ResendWebhooksController } from "./resend-webhooks.controller";

/**
 * POST /webhooks/resend.
 *
 * It used to need a session (so every event Resend sent was refused) and,
 * past that, did no signature check at all. Now it is public and the Svix
 * signature is the only thing that lets an event through: these tests send
 * what Resend would send, and what a forger would.
 */
describe("ResendWebhooksController", () => {
  const secret = "whsec_" + Buffer.from("fictitious-resend-signing-key").toString("base64");
  const body = JSON.stringify({
    type: "email.delivered",
    created_at: "2026-10-02T10:00:00.000Z",
    data: { email_id: "re_fake_1", to: ["cliente@example.test"] },
  });

  function build(configured = true) {
    const events = { handle: jest.fn().mockResolvedValue(undefined) };
    const config = { get: (k: string) => (k === "RESEND_WEBHOOK_SECRET" && configured ? secret : undefined) };
    const controller = new ResendWebhooksController(config as any, events as any);
    (controller as any).logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    return { controller, events };
  }

  const now = () => String(Math.floor(Date.now() / 1000));
  const req = (raw: string) => ({ rawBody: Buffer.from(raw) }) as any;

  async function status(p: Promise<unknown>): Promise<number> {
    try {
      await p;
      return 200;
    } catch (e) {
      return (e as HttpException).getStatus();
    }
  }

  it("is public, so Resend (which has no session) can reach it", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ResendWebhooksController.prototype.handleResendWebhook)).toBe(true);
  });

  it("processes a correctly signed event, parsed from the signed bytes", async () => {
    const { controller, events } = build();
    const ts = now();
    const sig = signSvixPayload(body, "msg_1", ts, secret);
    await expect(controller.handleResendWebhook(req(body), "msg_1", ts, sig)).resolves.toEqual({ received: true });
    expect(events.handle).toHaveBeenCalledWith(JSON.parse(body), "msg_1");
  });

  it("rejects an unsigned request with 401 and processes nothing", async () => {
    const { controller, events } = build();
    expect(await status(controller.handleResendWebhook(req(body), undefined, undefined, undefined))).toBe(401);
    expect(events.handle).not.toHaveBeenCalled();
  });

  it("rejects a forged signature with 401", async () => {
    const { controller, events } = build();
    const ts = now();
    const forged = signSvixPayload(body, "msg_1", ts, "whsec_" + Buffer.from("attacker").toString("base64"));
    expect(await status(controller.handleResendWebhook(req(body), "msg_1", ts, forged))).toBe(401);
    expect(events.handle).not.toHaveBeenCalled();
  });

  it("rejects a signed body that was altered in transit", async () => {
    const { controller, events } = build();
    const ts = now();
    const sig = signSvixPayload(body, "msg_1", ts, secret);
    const altered = body.replace("email.delivered", "email.complained");
    expect(await status(controller.handleResendWebhook(req(altered), "msg_1", ts, sig))).toBe(401);
    expect(events.handle).not.toHaveBeenCalled();
  });

  it("refuses with 503 when the secret is not configured, so Resend retries later", async () => {
    const { controller, events } = build(false);
    const ts = now();
    const sig = signSvixPayload(body, "msg_1", ts, secret);
    expect(await status(controller.handleResendWebhook(req(body), "msg_1", ts, sig))).toBe(503);
    expect(events.handle).not.toHaveBeenCalled();
  });
});
