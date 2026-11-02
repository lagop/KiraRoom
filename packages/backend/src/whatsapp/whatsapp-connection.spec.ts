import { ConflictException } from "@nestjs/common";
import { WhatsAppService, WHATSAPP_NUMBER_TAKEN } from "./whatsapp.service";

/**
 * Connecting a salon's WhatsApp number (B11, B20).
 *
 * - The answer to connect (manual and the OAuth callback) carried the whole
 *   row, encrypted access token included; it now has the same safe shape as
 *   GET /whatsapp/connection.
 * - The phone-number id was not unique, and inbound messages went to the
 *   last salon that entered it: a salon typing another's id received that
 *   salon's clients' messages. A second salon is refused now, and a number
 *   that two salons already hold routes nowhere.
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
    ...over,
  };
}

function service(opts: { taken?: { tenantId: string } | null; rows?: Array<{ tenantId: string; phoneNumberId: string }> } = {}) {
  const prisma: any = {
    whatsAppConnection: {
      findFirst: jest.fn(async () => opts.taken ?? null),
      upsert: jest.fn(async (args: any) => row({ tenantId: args.create.tenantId, phoneNumberId: args.create.phoneNumberId })),
      findUnique: jest.fn(async () => row()),
      findMany: jest.fn(async () => opts.rows ?? []),
      delete: jest.fn(async () => ({})),
    },
  };
  const meta: any = {
    encryptToken: jest.fn(() => ENC),
    exchangeCodeForToken: jest.fn(async () => ({ access_token: "from-meta", expires_in: 3600 })),
  };
  const config: any = { get: jest.fn(() => undefined) };
  const templates: any = { submitStandardTemplates: jest.fn(async () => undefined) };
  const s = new WhatsAppService(prisma, meta, config, {} as any, {} as any, templates);
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  (s as any).logger = logger;
  return { s, prisma, logger };
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

  it("the OAuth callback answers the safe shape", async () => {
    const { s } = service();
    const out = await s.completeOAuth("t1", "code");
    expectNoSecrets(out);
  });

  it("GET /whatsapp/connection answers the safe shape", async () => {
    const { s } = service();
    expectNoSecrets(await s.getConnection("t1"));
  });
});

describe("one salon per WhatsApp number (B11)", () => {
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

  it("lets the same salon reconnect its own number", async () => {
    const { s, prisma } = service({ taken: null });
    await s.manualConnect("t1", manual);
    expect(prisma.whatsAppConnection.upsert).toHaveBeenCalled();
  });

  it("the OAuth flow, which carries no number yet, skips the check", async () => {
    const { s, prisma } = service();
    await s.completeOAuth("t1", "code");
    expect(prisma.whatsAppConnection.findFirst).not.toHaveBeenCalled();
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
});
