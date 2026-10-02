import { BadRequestException } from "@nestjs/common";
import { ConsentService } from "./consent.service";
import { ConsentController } from "./consent.controller";
import {
  WHATSAPP_MARKETING_PURPOSE,
  clientsWhoAcceptedWhatsAppMarketing,
  clientsWhoRefusedMarketing,
} from "./marketing-consent";

/**
 * WhatsApp promotions need their own opt-in: Meta only allows marketing
 * messages to people who agreed to receive them from that business on
 * WhatsApp, so unlike email (customer exception, LSSI art. 21.2) silence is
 * a no. The choice is a signed Consent record like the email one; when the
 * salon records a choice made in person, the record says so.
 */

function makePrisma() {
  const forms: any[] = [];
  const consents: any[] = [];
  const formOf = (c: any) => forms.find((f) => f.id === c.formId);
  const matches = (c: any, where: any) =>
    (!where.tenantId || c.tenantId === where.tenantId) &&
    (!where.clientId || (typeof where.clientId === "string" ? c.clientId === where.clientId : where.clientId.in.includes(c.clientId))) &&
    (where.revokedAt !== null || c.revokedAt === null) &&
    (!where.form || formOf(c)?.purpose === where.form.purpose);
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

describe("WhatsApp marketing consent", () => {
  it("is a choice of its own, with WhatsApp wording, separate from email", async () => {
    const { prisma, forms } = makePrisma();
    const service = new ConsentService(prisma, encryption);

    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: true, channel: "whatsapp" });

    expect(forms).toHaveLength(1);
    expect(forms[0].purpose).toBe(WHATSAPP_MARKETING_PURPOSE);
    expect(forms[0].fields[0].label).toMatch(/WhatsApp.*BAJA/);
    expect((await service.getMarketingConsent("t1", "c1", "whatsapp")).status).toBe("granted");
    expect((await service.getMarketingConsent("t1", "c1", "email")).status).toBe("none");
  });

  it("treats silence as no, and a withdrawal as no", async () => {
    const { prisma } = makePrisma();
    const service = new ConsentService(prisma, encryption);
    expect([...(await clientsWhoAcceptedWhatsAppMarketing(prisma, "t1"))]).toEqual([]);

    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: true, channel: "whatsapp" });
    expect([...(await clientsWhoAcceptedWhatsAppMarketing(prisma, "t1"))]).toEqual(["c1"]);

    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: false, channel: "whatsapp" });
    expect([...(await clientsWhoAcceptedWhatsAppMarketing(prisma, "t1"))]).toEqual([]);
    // Saying no on WhatsApp does not unsubscribe them from email.
    expect([...(await clientsWhoRefusedMarketing(prisma, "t1"))]).toEqual([]);
  });

  it("records who in the salon wrote down a choice made in person", async () => {
    const { prisma, consents } = makePrisma();
    const service = new ConsentService(prisma, encryption);
    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: true, channel: "whatsapp", recordedBy: "staff-1" });
    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: false, channel: "whatsapp", recordedBy: "staff-1" });

    expect(consents[0].responses).toEqual({ accepts: true, source: "salon", recordedBy: "staff-1" });
    expect(consents[0].revokeReason).toBe("withdrawn_by_salon");
    expect(consents[1].responses).toEqual({ accepts: false, source: "salon", recordedBy: "staff-1" });
  });

  it("needs the salon to confirm the client agreed before recording a yes", () => {
    const service: any = { recordMarketingChoice: jest.fn() };
    const controller = new ConsentController(service);
    const req: any = { user: { id: "staff-1", tenantId: "t1" }, headers: {}, socket: {} };

    expect(() => controller.setClientWhatsAppMarketing(req, "c1", { accepts: true })).toThrow(BadRequestException);
    controller.setClientWhatsAppMarketing(req, "c1", { accepts: true, confirmedInPerson: true });
    controller.setClientWhatsAppMarketing(req, "c1", { accepts: false });
    expect(service.recordMarketingChoice.mock.calls.map((c: any[]) => [c[0].accepts, c[0].recordedBy, c[0].channel])).toEqual([
      [true, "staff-1", "whatsapp"],
      [false, "staff-1", "whatsapp"],
    ]);
  });
});
