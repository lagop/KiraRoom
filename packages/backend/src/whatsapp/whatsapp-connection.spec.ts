import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  CONNECT_ERRORS,
  WEBHOOK_OTHER_APP,
  WhatsAppService,
  WHATSAPP_NUMBER_TAKEN,
} from "./whatsapp.service";

/**
 * Connecting a salon's WhatsApp number (B11, B20, and the channels audit:
 * M1 webhook subscription, M4 checked with Meta, M5 "Comprobar de nuevo").
 *
 * - The answer to connect carried the whole row, encrypted access token
 *   included; it now has the same safe shape as GET /whatsapp/connection.
 * - The phone-number id was not unique, and inbound messages went to the
 *   last salon that entered it. A second salon is refused now, and a number
 *   that two salons already hold routes nowhere.
 * - Nothing was asked of Meta before saying "Conectado", and the account
 *   was never subscribed to KiraRoom's webhook, so no message arrived.
 *
 * Every Graph API call is mocked.
 */

const ENC = "enc-token-value";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    createdAt: new Date(),
    updatedAt: new Date(),
    tenantId: "t1",
    wabaId: "111",
    phoneNumberId: "222",
    businessId: null,
    displayPhone: "+34 600 000 000",
    displayName: "Salón Ana",
    accessTokenEnc: ENC,
    refreshTokenEnc: "enc-refresh",
    tokenExpiresAt: null,
    scopes: [],
    qualityScore: null,
    messagingLimit: null,
    isActive: true,
    lastSyncAt: null,
    webhookSubscribedAt: null,
    webhookError: null,
    lastInboundAt: null,
    authErrorAt: null,
    authError: null,
    attentionNotifiedAt: null,
    ...over,
  };
}

const ok = <T>(data: T) => ({ ok: true, data });
const fail = (code: number, message = "error") => ({ ok: false, error: { code, message } });

function service(
  opts: {
    taken?: { tenantId: string } | null;
    rows?: Array<{ tenantId: string; phoneNumberId: string }>;
    meta?: Record<string, any>;
    env?: Record<string, string>;
    upsert?: any;
  } = {},
) {
  let saved: any = row();
  const prisma: any = {
    whatsAppConnection: {
      findFirst: jest.fn(async () => opts.taken ?? null),
      upsert: jest.fn(
        opts.upsert ??
          (async (args: any) => {
            saved = row({ ...args.create });
            return saved;
          }),
      ),
      update: jest.fn(async (args: any) => {
        saved = { ...saved, ...args.data };
        return saved;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async () => saved),
      findMany: jest.fn(async () => opts.rows ?? []),
      delete: jest.fn(async () => ({})),
    },
  };
  const meta: any = {
    encryptToken: jest.fn(() => ENC),
    decryptToken: jest.fn(() => "stored-token"),
    getPhoneNumber: jest.fn(async () =>
      ok({ id: "222", display_phone_number: "+34 611 22 33 44", verified_name: "Salón Ana (Meta)", quality_rating: "GREEN" }),
    ),
    listPhoneNumbers: jest.fn(async () => ok({ data: [{ id: "222" }, { id: "999" }] })),
    debugToken: jest.fn(async () => ok({ data: { is_valid: true, expires_at: 0 } })),
    subscribeApp: jest.fn(async () => ok({ success: true })),
    listSubscribedApps: jest.fn(async () => ok({ data: [{ whatsapp_business_api_data: { id: "kira-app" } }] })),
    unsubscribeApp: jest.fn(async () => ok({ success: true })),
    ...(opts.meta ?? {}),
  };
  const env: Record<string, string> = { META_APP_ID: "kira-app", ...(opts.env ?? {}) };
  const config: any = { get: jest.fn((k: string) => env[k]) };
  const templates: any = { submitStandardTemplates: jest.fn(async () => undefined) };
  const health: any = { whatsAppError: jest.fn(async () => true) };
  const s = new WhatsAppService(prisma, meta, config, {} as any, {} as any, templates, health);
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  (s as any).logger = logger;
  return { s, prisma, meta, logger, health, templates, saved: () => saved };
}

const manual = { accessToken: "user-token", wabaId: "111", phoneNumberId: "222", displayPhone: "+34 600 000 000" };

function expectNoSecrets(out: unknown) {
  const json = JSON.stringify(out);
  expect(json).not.toContain(ENC);
  expect(json).not.toContain("enc-refresh");
  expect(out).not.toHaveProperty("accessTokenEnc");
  expect(out).not.toHaveProperty("refreshTokenEnc");
}

describe("WhatsApp connection responses carry no token (B20)", () => {
  it("manual connect answers the safe shape", async () => {
    const { s } = service();
    const out = await s.manualConnect("t1", manual);
    expectNoSecrets(out);
    expect(out).toMatchObject({ tenantId: "t1", phoneNumberId: "222", isActive: true });
  });

  it("GET /whatsapp/connection answers the safe shape", async () => {
    const { s } = service();
    expectNoSecrets(await s.getConnection("t1"));
  });
});

describe("the manual connection is checked with Meta before it is saved (M4)", () => {
  it("saves Meta's display number and verified name, and the token's real expiry", async () => {
    const expires = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;
    const { s, prisma, meta } = service({
      meta: { debugToken: jest.fn(async () => ok({ data: { is_valid: true, expires_at: expires } })) },
    });
    await s.manualConnect("t1", { ...manual, displayPhone: "typed by hand" });
    expect(meta.getPhoneNumber).toHaveBeenCalledWith("user-token", "222");
    expect(meta.listPhoneNumbers).toHaveBeenCalledWith("user-token", "111");
    const create = prisma.whatsAppConnection.upsert.mock.calls[0][0].create;
    expect(create).toMatchObject({
      displayPhone: "+34 611 22 33 44",
      displayName: "Salón Ana (Meta)",
      qualityScore: "GREEN",
      tokenExpiresAt: new Date(expires * 1000),
    });
  });

  it("refuses a token Meta does not accept, and saves nothing", async () => {
    const { s, prisma } = service({ meta: { getPhoneNumber: jest.fn(async () => fail(190, "Session has expired")) } });
    const err = await s.manualConnect("t1", manual).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(CONNECT_ERRORS.tokenInvalid);
    expect(prisma.whatsAppConnection.upsert).not.toHaveBeenCalled();
  });

  it("refuses a mistyped phone-number id or account id, with a message saying which", async () => {
    const phone = service({ meta: { getPhoneNumber: jest.fn(async () => fail(100, "Unsupported get request")) } });
    expect((await phone.s.manualConnect("t1", manual).catch((e) => e)).message).toBe(CONNECT_ERRORS.phoneNotFound);
    const waba = service({ meta: { listPhoneNumbers: jest.fn(async () => fail(100, "Unsupported get request")) } });
    expect((await waba.s.manualConnect("t1", manual).catch((e) => e)).message).toBe(CONNECT_ERRORS.wabaNotFound);
    expect(waba.prisma.whatsAppConnection.upsert).not.toHaveBeenCalled();
  });

  it("refuses a number that is not in that WhatsApp Business account (another salon's id)", async () => {
    const { s, prisma } = service({ meta: { listPhoneNumbers: jest.fn(async () => ok({ data: [{ id: "999" }] })) } });
    const err = await s.manualConnect("t1", manual).catch((e) => e);
    expect(err.message).toBe(CONNECT_ERRORS.numberNotInWaba);
    expect(prisma.whatsAppConnection.upsert).not.toHaveBeenCalled();
  });

  it("refuses the 24-hour token from API Setup, saying when it expires", async () => {
    const tomorrow = Math.floor(Date.now() / 1000) + 20 * 3600;
    const { s, prisma } = service({
      meta: { debugToken: jest.fn(async () => ok({ data: { is_valid: true, expires_at: tomorrow } })) },
    });
    const err = await s.manualConnect("t1", manual).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/token temporal/);
    expect(prisma.whatsAppConnection.upsert).not.toHaveBeenCalled();
  });

  it("goes on without an expiry when KiraRoom's app cannot inspect the token", async () => {
    const { s, prisma } = service({ meta: { debugToken: jest.fn(async () => null) } });
    await s.manualConnect("t1", manual);
    expect(prisma.whatsAppConnection.upsert.mock.calls[0][0].create.tokenExpiresAt).toBeNull();
  });

  it("says so when Meta cannot be reached", async () => {
    const { s } = service({
      meta: { getPhoneNumber: jest.fn(async () => ({ ok: false, error: { code: -1, message: "ECONNRESET", network: true } })) },
    });
    expect((await s.manualConnect("t1", manual).catch((e) => e)).message).toBe(CONNECT_ERRORS.unreachable);
  });
});

describe("the account is subscribed to KiraRoom's webhook on connect (M1)", () => {
  it("subscribes it and records that it is active", async () => {
    const { s, meta, saved } = service();
    const out = await s.manualConnect("t1", manual);
    expect(meta.subscribeApp).toHaveBeenCalledWith("user-token", "111");
    expect(saved().webhookSubscribedAt).toBeInstanceOf(Date);
    expect(saved().webhookError).toBeNull();
    expect(out.webhookSubscribedAt).toBeInstanceOf(Date);
  });

  it("keeps the connection but says why when Meta refuses the subscription", async () => {
    const { s, saved } = service({ meta: { subscribeApp: jest.fn(async () => fail(200, "Permissions error")) } });
    const out = await s.manualConnect("t1", manual);
    expect(out.isActive).toBe(true);
    expect(saved().webhookSubscribedAt).toBeNull();
    expect(saved().webhookError).toMatch(/Meta no ha permitido que KiraRoom reciba los mensajes de esta cuenta: Permissions error/);
  });

  it("does not promise messages when the subscribed app is the token's own, not KiraRoom's", async () => {
    const { s, saved } = service({
      meta: { listSubscribedApps: jest.fn(async () => ok({ data: [{ whatsapp_business_api_data: { id: "salon-app" } }] })) },
    });
    await s.manualConnect("t1", manual);
    expect(saved().webhookSubscribedAt).toBeNull();
    expect(saved().webhookError).toBe(WEBHOOK_OTHER_APP);
  });

  it("re-connecting clears an old access problem and subscribes again", async () => {
    const { s, prisma, meta } = service();
    await s.manualConnect("t1", manual);
    await s.manualConnect("t1", manual);
    const update = prisma.whatsAppConnection.upsert.mock.calls[1][0].update;
    expect(update).toMatchObject({ authErrorAt: null, authError: null, attentionNotifiedAt: null });
    expect(meta.subscribeApp).toHaveBeenCalledTimes(2);
  });

  it("an event from Meta proves the subscription and records when it arrived", async () => {
    const { s, prisma } = service({ rows: [{ tenantId: "t1", phoneNumberId: "222" }] });
    jest.spyOn(s as any, "handleChange").mockResolvedValue(undefined);
    await s.routeWebhook({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "222" } } }] }] });
    expect(prisma.whatsAppConnection.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1" },
      data: { lastInboundAt: expect.any(Date) },
    });
    expect(prisma.whatsAppConnection.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", webhookSubscribedAt: null },
      data: { webhookSubscribedAt: expect.any(Date), webhookError: null },
    });
  });
});

describe("Comprobar de nuevo (M5)", () => {
  it("clears the access problem when Meta accepts the stored token again", async () => {
    const { s, prisma, meta } = service();
    const out = await s.checkConnection("t1");
    expect(meta.getPhoneNumber).toHaveBeenCalledWith("stored-token", "222");
    expect(prisma.whatsAppConnection.update.mock.calls[0][0].data).toMatchObject({ authErrorAt: null, authError: null });
    expect(out.accessProblem).toBeNull();
    expectNoSecrets(out);
  });

  it("marks the connection when Meta still refuses the token", async () => {
    const { s, health } = service({ meta: { getPhoneNumber: jest.fn(async () => fail(190)) } });
    await expect(s.checkConnection("t1")).rejects.toBeInstanceOf(BadRequestException);
    expect(health.whatsAppError).toHaveBeenCalledWith("t1", 190);
  });

  it("the panel gets the reason in Spanish while the token is refused", async () => {
    const { s, saved } = service();
    Object.assign(saved(), { authErrorAt: new Date(), authError: "meta_190" });
    expect((await s.getConnection("t1"))!.accessProblem).toMatch(/ha caducado o ya no es válido/);
  });
});

describe("one salon per WhatsApp number (B11, M13)", () => {
  it("refuses a number another salon has connected, with a Spanish 409, and saves nothing", async () => {
    const { s, prisma } = service({ taken: { tenantId: "t-other" } });
    const err = await s.manualConnect("t1", manual).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(WHATSAPP_NUMBER_TAKEN);
    expect(prisma.whatsAppConnection.findFirst).toHaveBeenCalledWith({
      where: { phoneNumberId: "222", isActive: true, tenantId: { not: "t1" } },
      select: { tenantId: true },
    });
    expect(prisma.whatsAppConnection.upsert).not.toHaveBeenCalled();
  });

  it("two salons racing past the check: the unique index refuses the second one with the same 409", async () => {
    const { s } = service({
      upsert: async () => {
        throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "5" });
      },
    });
    const err = await s.manualConnect("t1", manual).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(WHATSAPP_NUMBER_TAKEN);
  });

  it("lets the same salon reconnect its own number", async () => {
    const { s, prisma } = service({ taken: null });
    await s.manualConnect("t1", manual);
    expect(prisma.whatsAppConnection.upsert).toHaveBeenCalled();
  });

  it("routes an inbound message to the only active salon with the number", async () => {
    const { s, prisma } = service({ rows: [{ tenantId: "t1", phoneNumberId: "222" }] });
    expect(await (s as any).lookupTenantByPhone("222")).toBe("t1");
    expect(prisma.whatsAppConnection.findMany).toHaveBeenCalledWith({
      where: { isActive: true, phoneNumberId: { not: "" } },
      select: { tenantId: true, phoneNumberId: true },
    });
  });

  it("drops (and logs) a message for a number two salons hold", async () => {
    const { s, logger } = service({
      rows: [
        { tenantId: "t1", phoneNumberId: "222" },
        { tenantId: "t2", phoneNumberId: "222" },
        { tenantId: "t3", phoneNumberId: "333" },
      ],
    });
    const handle = jest.spyOn(s as any, "handleChange").mockResolvedValue(undefined);
    await s.routeWebhook({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "222" } } }] }] });
    expect(handle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/more than one salon/));
    expect(await (s as any).lookupTenantByPhone("333")).toBe("t3");
  });

  it("a new connection or a disconnect rebuilds the routing index", async () => {
    const { s, prisma } = service({ rows: [{ tenantId: "t1", phoneNumberId: "222" }] });
    await (s as any).lookupTenantByPhone("222");
    await s.disconnect("t1");
    prisma.whatsAppConnection.findMany.mockResolvedValueOnce([]);
    expect(await (s as any).lookupTenantByPhone("222")).toBeNull();
    expect(prisma.whatsAppConnection.findMany).toHaveBeenCalledTimes(2);
  });

  it("a disconnect unsubscribes KiraRoom's app from the account's webhooks, then deletes the token", async () => {
    const { s, prisma, meta } = service();
    await s.disconnect("t1");
    expect(meta.unsubscribeApp).toHaveBeenCalledWith("stored-token", expect.any(String));
    expect(meta.unsubscribeApp.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.whatsAppConnection.delete.mock.invocationCallOrder[0],
    );
    expect(prisma.whatsAppConnection.delete).toHaveBeenCalledWith({ where: { tenantId: "t1" } });
  });

  it("Meta refusing the unsubscribe (a token the salon revoked) never blocks the disconnect", async () => {
    const { s, prisma } = service({
      meta: { unsubscribeApp: jest.fn(async () => ({ ok: false, error: { code: 190, message: "Invalid token" } })) },
    });
    await expect(s.disconnect("t1")).resolves.toEqual({ disconnected: true });
    expect(prisma.whatsAppConnection.delete).toHaveBeenCalled();
  });
});
