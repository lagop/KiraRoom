import { RECEIVING_UNAVAILABLE, WhatsAppService } from "./whatsapp.service";
import { PlatformMetaStatusController } from "./whatsapp.controller";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";

/**
 * Channels audit phase 2 (D20): the panel says plainly when KiraRoom cannot
 * receive WhatsApp at all (the platform's Meta app is not configured), and
 * "Probar recepción" tells the salon whether an event from Meta arrived.
 */
const VERIFY = "a-long-random-verify-value";

function service(env: Record<string, string | undefined>, conn: any = { webhookSubscribedAt: new Date(), webhookError: null }) {
  const prisma: any = {
    whatsAppConnection: {
      findUnique: jest.fn(async () => conn),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const config: any = { get: (k: string) => env[k] };
  const s = new WhatsAppService(prisma, {} as any, config, {} as any, {} as any, {} as any);
  return { s, prisma, config };
}

describe("WhatsApp setup status", () => {
  it("receives only with the app id, the app secret and a real verify token", () => {
    const ok = service({ META_APP_ID: "1", META_APP_SECRET: "s", META_WEBHOOK_VERIFY_TOKEN: VERIFY }).s;
    expect(ok.setupStatus()).toEqual({ receivingAvailable: true, receivingProblem: null });
    // Production today: the verify token is set, the app is not.
    const prod = service({ META_WEBHOOK_VERIFY_TOKEN: VERIFY }).s;
    expect(prod.platformStatus()).toEqual({ appIdSet: false, appSecretSet: false, verifyTokenSet: true, receiving: false });
    expect(prod.setupStatus()).toEqual({ receivingAvailable: false, receivingProblem: RECEIVING_UNAVAILABLE });
    expect(RECEIVING_UNAVAILABLE).toMatch(/falta configurar la app de Meta de la plataforma/);
  });

  it("the reception test starts now and resets the salon's write throttle", async () => {
    const { s, prisma } = service({ META_APP_ID: "1", META_APP_SECRET: "s", META_WEBHOOK_VERIFY_TOKEN: VERIFY });
    (s as any).inboundTouched.set("t1", Date.now());
    const before = Date.now();
    const out = await s.startReceptionTest("t1");
    expect((s as any).inboundTouched.has("t1")).toBe(false);
    expect(new Date(out.startedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(out.since).getTime()).toBeLessThan(new Date(out.startedAt).getTime());
    expect(out).toMatchObject({ receivingAvailable: true, subscribed: true, receivingProblem: null });
    // The next event is written at once.
    await (s as any).touchInbound("t1");
    expect(prisma.whatsAppConnection.updateMany).toHaveBeenCalled();
  });

  it("the reception test says why nothing can arrive", async () => {
    const { s } = service({}, { webhookSubscribedAt: null, webhookError: "otra app" });
    expect(await s.startReceptionTest("t1")).toMatchObject({
      receivingAvailable: false,
      subscribed: false,
      webhookError: "otra app",
    });
  });

  it("a salon with no WhatsApp connected cannot start one", async () => {
    const { s } = service({}, null);
    await expect(s.startReceptionTest("t1")).rejects.toThrow(/No WhatsApp connection/);
  });
});

describe("PlatformMetaStatusController", () => {
  it("is for the platform owner and shows which settings exist, never their values, and the webhook URLs", () => {
    expect(Reflect.getMetadata(ROLES_KEY, PlatformMetaStatusController.prototype.get)).toEqual(["saas_owner"]);
    const env: Record<string, string> = {
      META_APP_ID: "123",
      META_WEBHOOK_VERIFY_TOKEN: VERIFY,
      API_BASE_URL: "https://api.example.test/api/v1/",
    };
    const { s, config } = service(env);
    const out = new PlatformMetaStatusController(s, config).get();
    expect(out).toEqual({
      appIdSet: true,
      appSecretSet: false,
      verifyTokenSet: true,
      receiving: false,
      webhookUrls: {
        whatsapp: "https://api.example.test/api/v1/webhooks/meta/whatsapp",
        messengerInstagram: "https://api.example.test/api/v1/channels/webhooks/meta",
      },
    });
    expect(JSON.stringify(out)).not.toContain(VERIFY);
  });
});
