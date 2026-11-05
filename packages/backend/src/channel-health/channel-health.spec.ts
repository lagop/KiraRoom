import { ChannelHealthService, isBotTokenError, isPageTokenError, isWhatsAppAuthError } from "./channel-health.service";
import { ACCESS_LOST_NOTICE, ChannelAttentionScheduler } from "./channel-attention.scheduler";

/** Channels audit M5: a refused token marks the channel, and the owner is told once. */
describe("ChannelHealthService", () => {
  const prisma = () => ({
    whatsAppConnection: { updateMany: jest.fn(async () => ({ count: 1 })) },
    channelAccount: { updateMany: jest.fn(async () => ({ count: 1 })) },
  });

  it("knows which codes are about the token", () => {
    expect(isWhatsAppAuthError(190)).toBe(true);
    expect(isWhatsAppAuthError(131047)).toBe(false);
    // A network error is not a refused token.
    expect(isWhatsAppAuthError(-1)).toBe(false);
    expect(isWhatsAppAuthError(undefined)).toBe(false);
    expect(isPageTokenError(190)).toBe(true);
    expect(isPageTokenError(10)).toBe(false);
    expect(isBotTokenError(401)).toBe(true);
    expect(isBotTokenError(429)).toBe(false);
  });

  it("marks WhatsApp once (only while it is not marked) and resets the notice", async () => {
    const p = prisma();
    const s = new ChannelHealthService(p as any);
    (s as any).logger = { warn: jest.fn(), error: jest.fn() };
    expect(await s.whatsAppError("t1", 190)).toBe(true);
    expect(p.whatsAppConnection.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", authErrorAt: null },
      data: { authErrorAt: expect.any(Date), authError: "meta_190", attentionNotifiedAt: null },
    });
    expect(await s.whatsAppError("t1", 131026)).toBe(false);
    expect(p.whatsAppConnection.updateMany).toHaveBeenCalledTimes(1);
  });

  it("marks the facebook row for a Page token, the telegram row for a bot token", async () => {
    const p = prisma();
    const s = new ChannelHealthService(p as any);
    (s as any).logger = { warn: jest.fn(), error: jest.fn() };
    await s.pageTokenError("t1", 190);
    await s.botTokenError("t1", 401);
    expect(p.channelAccount.updateMany.mock.calls.map((c: any[]) => [c[0].where.channel, c[0].data.authError])).toEqual([
      ["facebook", "meta_190"],
      ["telegram", "telegram_401"],
    ]);
  });

  it("never throws, so a send is not broken by the report", async () => {
    const p = prisma();
    p.whatsAppConnection.updateMany.mockRejectedValueOnce(new Error("db down"));
    const s = new ChannelHealthService(p as any);
    (s as any).logger = { warn: jest.fn(), error: jest.fn() };
    await expect(s.whatsAppError("t1", 190)).resolves.toBe(false);
  });
});

describe("ChannelAttentionScheduler", () => {
  function setup(over: { claimed?: number } = {}) {
    const prisma = {
      whatsAppConnection: {
        findMany: jest.fn(async () => [{ tenantId: "t1" }]),
        updateMany: jest.fn(async () => ({ count: over.claimed ?? 1 })),
      },
      channelAccount: {
        findMany: jest.fn(async () => [{ id: "a1", tenantId: "t2", channel: "telegram" }]),
        updateMany: jest.fn(async () => ({ count: over.claimed ?? 1 })),
      },
      user: {
        findMany: jest.fn(async () => [
          { id: "u1", email: "owner@example.test", role: "owner" },
          { id: "u2", email: "admin@example.test", role: "admin" },
        ]),
      },
    };
    const notifications = { create: jest.fn(async () => ({})) };
    const email = { sendEmail: jest.fn(async () => ({ success: true })) };
    const config = { get: (k: string) => (k === "APP_BASE_URL" ? "https://app.example.test/" : undefined) };
    const s = new ChannelAttentionScheduler(prisma as any, notifications as any, email as any, config as any);
    return { s, prisma, notifications, email };
  }

  it("tells every owner and admin in the panel and emails the owner, per channel", async () => {
    const { s, notifications, email } = setup();
    expect(await s.notifyPending()).toBe(2);
    expect(notifications.create).toHaveBeenCalledTimes(4);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: "u1",
        type: "system_alert",
        title: ACCESS_LOST_NOTICE.whatsapp.title,
        data: { kind: "channel_access_lost", channel: "whatsapp", url: "/dashboard/settings/whatsapp" },
      }),
    );
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    expect(email.sendEmail.mock.calls.map((c: any[]) => c[0].to)).toEqual(["owner@example.test", "owner@example.test"]);
    expect((email.sendEmail.mock.calls[0] as any[])[0].text).toContain("https://app.example.test/dashboard/settings/whatsapp");
  });

  it("sends nothing for a mark another instance already claimed", async () => {
    const { s, notifications, email } = setup({ claimed: 0 });
    expect(await s.notifyPending()).toBe(0);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("claims only marks not yet notified", async () => {
    const { s, prisma } = setup();
    await s.notifyPending();
    expect(prisma.whatsAppConnection.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", authErrorAt: { not: null }, attentionNotifiedAt: null },
      data: { attentionNotifiedAt: expect.any(Date) },
    });
  });
});
