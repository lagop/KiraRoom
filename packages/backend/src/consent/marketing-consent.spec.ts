import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ConsentService } from "./consent.service";
import { MarketingChoiceDto } from "./consent.controller";
import { clientsWhoRefusedMarketing, MARKETING_PURPOSE } from "./marketing-consent";
import { EmailCampaignsService } from "../email-campaigns/email-campaigns.service";

/**
 * The salon site's account page kept "Recibe ofertas por email" in
 * localStorage and said "guardado": the salon never knew, and campaigns
 * kept going to a client who had said no. The choice is now a signed
 * Consent record (never a bare boolean), and campaign sends honour it.
 */

function makePrisma() {
  const forms: any[] = [];
  const consents: any[] = [];
  const matches = (c: any, where: any) =>
    (!where.tenantId || c.tenantId === where.tenantId) &&
    (!where.clientId || (typeof where.clientId === "string" ? c.clientId === where.clientId : where.clientId.in.includes(c.clientId))) &&
    (where.revokedAt !== null || c.revokedAt === null) &&
    (!where.form || forms.find((f) => f.id === c.formId)?.purpose === where.form.purpose);
  const prisma: any = {
    client: {
      findFirst: async ({ where }: any) =>
        where.id === "c1" && where.tenantId === "t1" ? { firstName: "Ana", lastName: "Pérez" } : null,
    },
    consentForm: {
      findFirst: async ({ where }: any) =>
        forms.find((f) => f.tenantId === where.tenantId && f.purpose === where.purpose && f.isActive) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `f${forms.length + 1}`, isActive: true, ...data };
        forms.push(row);
        return row;
      },
      findMany: jest.fn(async () => []),
      findUnique: async ({ where }: any) => forms.find((f) => f.id === where.id) ?? null,
    },
    consent: {
      findFirst: async ({ where }: any) =>
        consents.filter((c) => matches(c, where)).sort((a, b) => b.signedAt - a.signedAt)[0] ?? null,
      findMany: async ({ where }: any) => consents.filter((c) => matches(c, where)),
      updateMany: async ({ where, data }: any) => {
        const rows = consents.filter((c) => matches(c, where));
        rows.forEach((c) => Object.assign(c, data));
        return { count: rows.length };
      },
      create: async ({ data }: any) => {
        const row = { id: `k${consents.length + 1}`, revokedAt: null, ...data };
        consents.push(row);
        return row;
      },
    },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  return { prisma, forms, consents };
}

const encryption: any = { hashIp: (ip: string) => `hash(${ip})` };

describe("marketing consent from the client's account", () => {
  it("is a signed record with the wording shown, the client's name and the hashed IP", async () => {
    const { prisma, forms, consents } = makePrisma();
    const service = new ConsentService(prisma, encryption);

    const state = await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: true, ip: "1.2.3.4" });

    expect(state.status).toBe("granted");
    expect(forms).toHaveLength(1);
    expect(forms[0].purpose).toBe(MARKETING_PURPOSE);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      tenantId: "t1",
      clientId: "c1",
      formId: forms[0].id,
      responses: { accepts: true },
      signatureName: "Ana Pérez",
      signatureIpHash: "hash(1.2.3.4)",
    });
    expect(consents[0].formSnapshot[0].label).toBe(state.text);
  });

  it("a withdrawal revokes the grant (kept for the record) and signs the refusal", async () => {
    const { prisma, consents } = makePrisma();
    const service = new ConsentService(prisma, encryption);
    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: true });

    const state = await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: false });

    expect(state.status).toBe("refused");
    expect(consents).toHaveLength(2);
    expect(consents[0].revokedAt).toBeInstanceOf(Date);
    expect(consents[0].revokeReason).toBe("withdrawn_by_client");
    expect(consents[1]).toMatchObject({ revokedAt: null, responses: { accepts: false } });
  });

  it("repeating the current choice records nothing", async () => {
    const { prisma, consents } = makePrisma();
    const service = new ConsentService(prisma, encryption);
    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: false });
    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: false });
    expect(consents).toHaveLength(1);
  });

  it("no record means no choice yet", async () => {
    const { prisma } = makePrisma();
    const state = await new ConsentService(prisma, encryption).getMarketingConsent("t1", "c1");
    expect(state).toMatchObject({ status: "none", decidedAt: null });
  });

  it("only a boolean is accepted", () => {
    const errors = validateSync(plainToInstance(MarketingChoiceDto, { accepts: "yes" }));
    expect(errors.map((e) => e.property)).toEqual(["accepts"]);
  });

  it("is never a form a booking requires, and cannot be signed through the public route", async () => {
    const { prisma, forms } = makePrisma();
    const service = new ConsentService(prisma, encryption);
    await service.getRequiredForms("t1", "svc-1");
    expect(prisma.consentForm.findMany.mock.calls[0][0].where.purpose).toEqual({ not: MARKETING_PURPOSE });

    const form = await service.ensureMarketingForm("t1");
    expect(forms).toHaveLength(1);
    await expect(
      service.sign({ tenantId: "t1", clientId: "c1", formId: form.id, responses: { accepts: true }, signatureName: "Ana" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("campaign senders see who said no", async () => {
    const { prisma } = makePrisma();
    const service = new ConsentService(prisma, encryption);
    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: false });

    const refused = await clientsWhoRefusedMarketing(prisma, "t1", ["c1", "c2"]);
    expect([...refused]).toEqual(["c1"]);
  });

  it("an email campaign skips, at send time, a client who said no", async () => {
    const { prisma: consentPrisma } = makePrisma();
    await new ConsentService(consentPrisma, encryption).recordMarketingChoice({
      tenantId: "t1",
      clientId: "c1",
      accepts: false,
    });
    const recipientUpdates: any[] = [];
    const prisma: any = {
      consent: consentPrisma.consent,
      emailCampaign: {
        findFirst: async () => ({
          id: "camp",
          status: "draft",
          subject: "Ofertas",
          content: "<p>hola</p>",
          recipients: [
            { id: "r1", clientId: "c1", email: "ana@example.test" },
            { id: "r2", clientId: "c2", email: "eva@example.test" },
          ],
        }),
        update: async () => ({}),
      },
      emailCampaignRecipient: { update: async (args: any) => recipientUpdates.push(args) },
    };
    const email = { sendEmail: jest.fn().mockResolvedValue({ success: true }) };
    const campaigns = new EmailCampaignsService(prisma, email as any);

    const result: any = await campaigns.sendCampaignNow("t1", "camp");

    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0][0].to).toBe("eva@example.test");
    expect(result.skippedCount).toBe(1);
    expect(recipientUpdates.find((u) => u.where.id === "r1").data.status).toBe("unsubscribed");
  });
});
