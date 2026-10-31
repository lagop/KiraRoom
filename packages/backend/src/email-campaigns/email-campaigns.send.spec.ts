import { BadRequestException } from "@nestjs/common";
import { EmailCampaignsService } from "./email-campaigns.service";
import { EmailUnsubscribeService } from "./email-unsubscribe.service";

/**
 * Sending a campaign.
 *
 * Before: the result of each send was ignored (a refused email counted as
 * sent), the recipient got a made-up message id (`campaign_<id>_<id>`) that
 * no Resend event could ever match, "delivered" was set to "sent", and an
 * address that had bounced or complained was emailed again. These tests
 * pin what replaced it.
 */
describe("EmailCampaignsService.deliverCampaign", () => {
  function setup(
    opts: {
      configured?: boolean;
      suppressed?: string[];
      claim?: number;
      extraRecipients?: Array<{ id: string; clientId: string | null; email: string; status: string }>;
      notActive?: string[];
    } = {},
  ) {
    const recipients = [
      { id: "r1", clientId: "k1", email: "ana@example.test", status: "pending" },
      { id: "r2", clientId: "k2", email: "Rebotada@Example.test", status: "pending" },
      { id: "r3", clientId: "k3", email: "fallo@example.test", status: "pending" },
      ...(opts.extraRecipients ?? []),
    ];
    const prisma: any = {
      emailCampaign: {
        findFirst: jest.fn().mockResolvedValue({ id: "c1", tenantId: "t1", status: "draft" }),
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: "c1",
          tenantId: "t1",
          subject: "Ofertas de otoño",
          content: "<p>Hola</p>",
          replyTo: null,
          recipients,
          tenant: { name: "Salón Lucía" },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: opts.claim ?? 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      emailCampaignRecipient: {
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // The salon's active clients among those asked for.
      client: {
        findMany: jest.fn(async ({ where }: any) =>
          where.id.in.filter((id: string) => !(opts.notActive ?? []).includes(id)).map((id: string) => ({ id })),
        ),
      },
      // Nobody here said no to promotions (marketing-consent.spec covers that).
      consent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const email: any = {
      isConfigured: () => opts.configured ?? true,
      sendEmail: jest.fn(async ({ to }: { to: string }) =>
        to.startsWith("fallo") ? { success: false, error: "Invalid `to` field" } : { success: true, id: `re_${to}` },
      ),
    };
    const suppressions: any = {
      suppressedAmong: jest.fn().mockResolvedValue(new Set(opts.suppressed ?? [])),
    };
    // The real link builder: only its config is used to sign and build URLs.
    const env: Record<string, string> = { JWT_SECRET: "test-secret", APP_BASE_URL: "https://app.test" };
    const unsubscribes = new EmailUnsubscribeService({} as any, { get: (k: string) => env[k] } as any, {} as any, {} as any);
    const service = new EmailCampaignsService(prisma, email, suppressions, unsubscribes);
    (service as any).logger = { log: jest.fn() };
    return { service, prisma, email, unsubscribes };
  }

  it("stores Resend's id, skips suppressed addresses and records failures as failures", async () => {
    const { service, prisma, email } = setup({ suppressed: ["rebotada@example.test"] });
    const result = await service.sendCampaignNow("t1", "c1");

    expect(result).toEqual({
      success: true,
      sentCount: 1,
      failedCount: 1,
      suppressedCount: 1,
      skippedCount: 0,
      droppedCount: 0,
    });
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    expect(email.sendEmail).not.toHaveBeenCalledWith(expect.objectContaining({ to: "Rebotada@Example.test" }));

    const updates = prisma.emailCampaignRecipient.update.mock.calls.map((c: any[]) => c[0]);
    expect(updates).toEqual(
      expect.arrayContaining([
        { where: { id: "r1" }, data: expect.objectContaining({ status: "sent", messageId: "re_ana@example.test" }) },
        { where: { id: "r2" }, data: expect.objectContaining({ status: "suppressed" }) },
        { where: { id: "r3" }, data: expect.objectContaining({ status: "failed", errorMessage: "Invalid `to` field" }) },
      ]),
    );
  });

  it("counts only what it knows: sent, never delivered or bounced", async () => {
    const { service, prisma } = setup();
    await service.sendCampaignNow("t1", "c1");
    const calls = prisma.emailCampaign.update.mock.calls;
    const final = calls[calls.length - 1][0];
    expect(final.data).toEqual({ status: "sent", sentAt: expect.any(Date), emailsSent: { increment: 2 } });
  });

  it("claims the campaign so a double click cannot send it twice", async () => {
    const { service, email } = setup({ claim: 0 });
    await expect(service.sendCampaignNow("t1", "c1")).rejects.toBeInstanceOf(BadRequestException);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("refuses to 'send' when email is not configured, instead of marking it sent", async () => {
    const { service, prisma, email } = setup({ configured: false });
    await expect(service.sendCampaignNow("t1", "c1")).rejects.toThrow(/no está configurado/);
    expect(prisma.emailCampaign.updateMany).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("gives every email its own unsubscribe link, in the footer and the List-Unsubscribe header", async () => {
    // LSSI art. 21.2: each commercial email must offer a simple way to object.
    const { service, email, unsubscribes } = setup();
    await service.sendCampaignNow("t1", "c1");
    const sent = email.sendEmail.mock.calls.map((c: any[]) => c[0]);
    expect(sent.length).toBe(3);
    for (const [i, msg] of sent.entries()) {
      const id = ["r1", "r2", "r3"][i];
      const pageUrl = "https://app.test/public/baja/" + unsubscribes.tokenFor({ kind: "r", id });
      expect(msg.html).toContain("date de baja aquí");
      expect(msg.html).toContain(pageUrl);
      expect(msg.html).toContain("cliente de Salón Lucía");
      expect(msg.headers["List-Unsubscribe"]).toBe("<" + pageUrl + ">");
    }
  });
});

describe("EmailCampaignsService.deliverCampaign: active clients only", () => {
  function setup(extra: any[], notActive: string[]) {
    const recipients = [{ id: "r1", clientId: "k1", email: "ana@example.test", status: "pending" }, ...extra];
    const prisma: any = {
      emailCampaign: {
        findFirst: jest.fn().mockResolvedValue({ id: "c1", tenantId: "t1", status: "draft" }),
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: "c1", tenantId: "t1", subject: "Ofertas", content: "<p>Hola</p>", replyTo: null, recipients, tenant: { name: "Salón" },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      emailCampaignRecipient: { update: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      client: {
        findMany: jest.fn(async ({ where }: any) => {
          expect(where).toMatchObject({ tenantId: "t1", status: "active" });
          return where.id.in.filter((id: string) => !notActive.includes(id)).map((id: string) => ({ id }));
        }),
      },
      consent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const email: any = { isConfigured: () => true, sendEmail: jest.fn(async () => ({ success: true, id: "re_1" })) };
    const suppressions: any = { suppressedAmong: jest.fn().mockResolvedValue(new Set()) };
    const unsubscribes: any = { link: () => ({ pageUrl: "https://app.test/baja", headers: {} }), withFooter: (h: string) => h };
    const service = new EmailCampaignsService(prisma, email, suppressions, unsubscribes);
    (service as any).logger = { log: jest.fn() };
    return { service, prisma, email };
  }

  it("drops a recipient whose client was deleted or is no longer active, and emails the rest", async () => {
    const { service, prisma, email } = setup(
      [
        { id: "r2", clientId: null, email: "borrada@example.test", status: "pending" },
        { id: "r3", clientId: "k3", email: "bloqueada@example.test", status: "pending" },
        { id: "r4", clientId: "k4", email: "inactiva@example.test", status: "pending" },
      ],
      ["k3", "k4"],
    );

    const result = await service.sendCampaignNow("t1", "c1");

    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0][0].to).toBe("ana@example.test");
    expect(result).toMatchObject({ sentCount: 1, droppedCount: 3 });
    expect(prisma.emailCampaignRecipient.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["r2", "r3", "r4"] }, campaignId: "c1", status: "pending" },
    });
    const calls = prisma.emailCampaign.update.mock.calls;
    expect(calls[calls.length - 1][0].data).toMatchObject({ totalRecipients: { decrement: 3 } });
  });

  it("deletes nothing when every recipient is an active client", async () => {
    const { service, prisma } = setup([], []);
    const result = await service.sendCampaignNow("t1", "c1");
    expect(result).toMatchObject({ sentCount: 1, droppedCount: 0 });
    expect(prisma.emailCampaignRecipient.deleteMany).not.toHaveBeenCalled();
  });
});
