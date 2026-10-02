import { NotFoundException } from "@nestjs/common";
import { EmailUnsubscribeService, maskEmail } from "./email-unsubscribe.service";

/**
 * The unsubscribe link of marketing emails.
 *
 * Before: campaigns had no way to unsubscribe, which the LSSI (art. 21.2 and
 * 22.1) requires in every commercial email. These tests pin that the link
 * cannot be forged, carries no address, and that using it stops the emails
 * and records the refusal where the client's account reads it.
 */
describe("EmailUnsubscribeService", () => {
  function setup(env: Record<string, string> = {}) {
    const config = {
      get: (k: string) => ({ JWT_SECRET: "test-secret", APP_BASE_URL: "https://app.test/", ...env })[k],
    };
    const recipient = {
      id: "rec-1",
      email: "Ana.Garcia@example.test",
      clientId: "cli-1",
      campaignId: "camp-1",
      campaign: { tenantId: "t1", tenant: { name: "Salón Lucía" } },
    };
    const prisma: any = {
      emailCampaignRecipient: {
        findUnique: jest.fn(async ({ where }: any) => (where.id === recipient.id ? recipient : null)),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      emailCampaign: { update: jest.fn().mockResolvedValue({}) },
      client: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === "cli-2"
            ? { id: "cli-2", email: "eva@example.test", tenantId: "t1", tenant: { name: "Salón Lucía" } }
            : null,
        ),
      },
    };
    const suppressed = new Set<string>();
    const suppressions: any = {
      suppress: jest.fn(async (_t: string, email: string) => suppressed.add(email.toLowerCase())),
      suppressedAmong: jest.fn(async (_t: string, emails: string[]) =>
        new Set(emails.map((e) => e.toLowerCase()).filter((e) => suppressed.has(e))),
      ),
    };
    const consent: any = { recordMarketingChoice: jest.fn().mockResolvedValue({ status: "refused" }) };
    const service = new EmailUnsubscribeService(prisma, config as any, suppressions, consent);
    (service as any).logger = { warn: jest.fn() };
    return { service, prisma, suppressions, consent };
  }

  it("signs links it can read back, and refuses altered or foreign ones", () => {
    const { service } = setup();
    const token = service.tokenFor({ kind: "r", id: "rec-1" });
    expect(service.parse(token)).toEqual({ kind: "r", id: "rec-1" });

    const [payload, sig] = token.split(".");
    const otherPayload = Buffer.from("r.rec-2").toString("base64url");
    expect(service.parse(`${otherPayload}.${sig}`)).toBeNull();
    expect(service.parse(`${payload}.${sig.slice(0, -1)}x`)).toBeNull();
    expect(service.parse("")).toBeNull();
    expect(service.parse(`${payload}.${sig}.extra`)).toBeNull();

    const { service: otherKey } = setup({ JWT_SECRET: "another-secret" });
    expect(otherKey.parse(token)).toBeNull();
  });

  it("puts no email address in the link", () => {
    const { service } = setup();
    const { pageUrl } = service.link({ kind: "r", id: "rec-1" });
    expect(pageUrl).toMatch(/^https:\/\/app\.test\/public\/baja\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(pageUrl).not.toMatch(/@|example/i);
  });

  it("offers one-click unsubscribe (RFC 8058) only when the API's public URL is known", () => {
    const withApi = setup({ API_BASE_URL: "https://api.test/" }).service.link({ kind: "c", id: "cli-2" });
    expect(withApi.headers["List-Unsubscribe"]).toMatch(
      /^<https:\/\/api\.test\/api\/v1\/public\/email\/unsubscribe\/[^>]+>$/,
    );
    expect(withApi.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    const withoutApi = setup().service.link({ kind: "c", id: "cli-2" });
    expect(withoutApi.headers).toEqual({ "List-Unsubscribe": `<${withoutApi.pageUrl}>` });
  });

  it("adds the footer before </body>, or at the end, and escapes the salon name", () => {
    const { service } = setup();
    const inBody = service.withFooter("<html><body><p>Hola</p></body></html>", "Ana & Co", "https://app.test/public/baja/x");
    expect(inBody).toMatch(/<p>Hola<\/p><p style=.*date de baja aquí<\/a>\.<\/p><\/body><\/html>$/);
    expect(inBody).toContain("cliente de Ana &amp; Co");
    expect(service.withFooter("<p>Hola</p>", "Salón", "https://x.test/b")).toMatch(/^<p>Hola<\/p><p .*href="https:\/\/x\.test\/b"/);
  });

  it("describes the link with the address masked", async () => {
    const { service } = setup();
    const info = await service.describe(service.tokenFor({ kind: "r", id: "rec-1" }));
    expect(info).toEqual({ salonName: "Salón Lucía", email: "An•••@example.test", unsubscribed: false });
    expect(maskEmail("a@b.test")).toBe("a•••@b.test");
  });

  it("unsubscribing stops the emails, records the refusal and counts it once", async () => {
    const { service, prisma, suppressions, consent } = setup();
    const token = service.tokenFor({ kind: "r", id: "rec-1" });

    await expect(service.unsubscribe(token)).resolves.toEqual({ salonName: "Salón Lucía", unsubscribed: true });
    expect(suppressions.suppress).toHaveBeenCalledWith("t1", "Ana.Garcia@example.test", "unsubscribed");
    expect(consent.recordMarketingChoice).toHaveBeenCalledWith({ tenantId: "t1", clientId: "cli-1", accepts: false });
    expect(prisma.emailCampaign.update).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { unsubscribes: { increment: 1 } },
    });
    expect((await service.describe(token)).unsubscribed).toBe(true);

    // The second click finds the recipient already marked: no second count.
    prisma.emailCampaignRecipient.updateMany.mockResolvedValueOnce({ count: 0 });
    await service.unsubscribe(token);
    expect(prisma.emailCampaign.update).toHaveBeenCalledTimes(1);
  });

  it("works for re-engagement emails, which link the client", async () => {
    const { service, suppressions, consent, prisma } = setup();
    await service.unsubscribe(service.tokenFor({ kind: "c", id: "cli-2" }));
    expect(suppressions.suppress).toHaveBeenCalledWith("t1", "eva@example.test", "unsubscribed");
    expect(consent.recordMarketingChoice).toHaveBeenCalledWith({ tenantId: "t1", clientId: "cli-2", accepts: false });
    expect(prisma.emailCampaign.update).not.toHaveBeenCalled();
  });

  it("still unsubscribes when the consent record cannot be written", async () => {
    const { service, suppressions, consent } = setup();
    consent.recordMarketingChoice.mockRejectedValueOnce(new Error("db down"));
    await service.unsubscribe(service.tokenFor({ kind: "r", id: "rec-1" }));
    expect(suppressions.suppress).toHaveBeenCalled();
  });

  it("answers 404 for an unknown or forged link", async () => {
    const { service } = setup();
    await expect(service.unsubscribe("nope")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.describe(service.tokenFor({ kind: "r", id: "missing" }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
