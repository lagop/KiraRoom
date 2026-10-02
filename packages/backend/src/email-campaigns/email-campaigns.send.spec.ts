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
  function setup(opts: { configured?: boolean; suppressed?: string[]; claim?: number } = {}) {
    const recipients = [
      { id: "r1", email: "ana@example.test", status: "pending" },
      { id: "r2", email: "Rebotada@Example.test", status: "pending" },
      { id: "r3", email: "fallo@example.test", status: "pending" },
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
      emailCampaignRecipient: { update: jest.fn().mockResolvedValue({}) },
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
    const config: any = { get: jest.fn() };
    // The real link builder: only its config is used to sign and build URLs.
    const env: Record<string, string> = { JWT_SECRET: "test-secret", APP_BASE_URL: "https://app.test" };
    const unsubscribes = new EmailUnsubscribeService({} as any, { get: (k: string) => env[k] } as any, {} as any, {} as any);
    const service = new EmailCampaignsService(prisma, email, suppressions, config, unsubscribes);
    (service as any).logger = { log: jest.fn() };
    return { service, prisma, email, unsubscribes };
  }

  it("stores Resend's id, skips suppressed addresses and records failures as failures", async () => {
    const { service, prisma, email } = setup({ suppressed: ["rebotada@example.test"] });
    const result = await service.sendCampaignNow("t1", "c1");

    expect(result).toEqual({ success: true, sentCount: 1, failedCount: 1, suppressedCount: 1, skippedCount: 0 });
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
