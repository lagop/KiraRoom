import { BadGatewayException, BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InvoiceEmailService } from "./invoice-email.service";
import { InvoiceRenderService } from "./pdf/invoice-render.service";
import { InvoicePdfService } from "./pdf/invoice-pdf.service";
import { EmailService } from "../notifications/services/email.service";

/**
 * "Enviar por email" (POST /invoices/:id/email): the invoice's PDF attached,
 * to the client's email or to the address typed, logged in the audit log.
 * The PDF is really rendered; the mail provider (Resend) is a stub.
 */

const TENANT = "tenant-1";
const ACTOR = { id: "user-1", role: "owner" as any };

function setup(opts: {
  invoice?: Record<string, unknown> | null;
  clientEmail?: string | null;
  resendError?: { message: string } | null;
  configured?: boolean;
} = {}) {
  const invoice =
    opts.invoice === null
      ? null
      : {
          id: "inv-1",
          tenantId: TENANT,
          series: "A",
          number: "000012",
          issueDate: new Date("2026-10-30T10:00:00.000Z"),
          recipientType: "client",
          recipientId: "client-1",
          recipientName: "Lucía Fernández",
          recipientTaxId: null,
          recipientAddress: null,
          subtotalCents: 2479,
          totalCents: 3000,
          taxBreakdown: [{ rate: 21, baseCents: 2479, taxCents: 521 }],
          currency: "EUR",
          status: "issued",
          notes: null,
          fiscalReference: null,
          fiscalHash: null,
          fiscalQrUrl: null,
          issuerNameAtIssue: "Salón Luna S.L.",
          issuerTaxIdAtIssue: "B12345678",
          lines: [
            {
              description: "Corte",
              quantity: 1,
              unitPriceCents: 2479,
              discountPct: 0,
              taxRate: 21,
              totalCents: 3000,
              rectifiesLineId: null,
            },
          ],
          ...opts.invoice,
        };
  const audit = { record: jest.fn(async () => ({ id: "audit-1" })) };
  const prisma = {
    invoice: { findFirst: jest.fn(async () => invoice) },
    invoiceLine: { findFirst: jest.fn(async () => null) },
    client: {
      findFirst: jest.fn(async () => (opts.clientEmail === undefined ? { email: "lucia@example.com" } : { email: opts.clientEmail })),
    },
    tenant: {
      findUnique: jest.fn(async () => ({
        name: "Salón Luna",
        legalName: "Salón Luna S.L.",
        taxId: "B12345678",
        street: "Calle Mayor 1",
        city: "Madrid",
        state: null,
        postalCode: "28001",
        country: "ES",
        email: "hola@luna.es",
        phone: null,
        timezone: "Europe/Madrid",
        fiscalSettings: { taxRegime: "iva" },
      })),
    },
  };
  const config = { get: (k: string) => (k === "RESEND_API_KEY" && opts.configured !== false ? "re_test" : undefined) } as unknown as ConfigService;
  const email = new EmailService(config, {} as any, { user: { findUnique: async () => null } } as any);
  const sent: any[] = [];
  (email as any).resend = {
    emails: {
      send: async (payload: any) => {
        sent.push(payload);
        return opts.resendError ? { data: null, error: opts.resendError } : { data: { id: "email-1" }, error: null };
      },
    },
  };
  (email as any).resendKey = "re_test";
  const render = new InvoiceRenderService(prisma as any, new InvoicePdfService({ get: () => undefined } as any));
  const service = new InvoiceEmailService(prisma as any, render, email, audit as any);
  return { service, sent, audit, prisma };
}

describe("InvoiceEmailService", () => {
  it("sends the PDF to the client's email, in Spanish, and logs who sent it", async () => {
    const { service, sent, audit } = setup();
    await expect(service.send(TENANT, "inv-1", ACTOR)).resolves.toEqual({ sent: true, to: "lucia@example.com" });

    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail.to).toEqual(["lucia@example.com"]);
    expect(mail.subject).toBe("Factura simplificada A000012 de Salón Luna");
    expect(mail.replyTo).toBe("hola@luna.es");
    expect(mail.html).toContain("Hola Lucía Fernández,");
    expect(mail.html).toContain("30/10/2026");
    expect(mail.text).toMatch(/Total: 30,00\s€/);
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0].filename).toBe("factura-A000012.pdf");
    expect(mail.attachments[0].contentType).toBe("application/pdf");
    expect(Buffer.isBuffer(mail.attachments[0].content)).toBe(true);
    expect(mail.attachments[0].content.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    expect(audit.record).toHaveBeenCalledWith("invoice.emailed", {
      actorId: "user-1",
      actorRole: "owner",
      tenantId: TENANT,
      metadata: expect.objectContaining({ invoiceId: "inv-1", number: "A000012", to: "lucia@example.com", toClientEmail: true }),
    });
  });

  it("sends to the address typed in the dialog instead", async () => {
    const { service, sent, audit } = setup({ clientEmail: null });
    await expect(service.send(TENANT, "inv-1", ACTOR, "  gestoria@example.com ")).resolves.toEqual({
      sent: true,
      to: "gestoria@example.com",
    });
    expect(sent[0].to).toEqual(["gestoria@example.com"]);
    expect((audit.record.mock.calls[0] as any[])[1].metadata.toClientEmail).toBe(false);
  });

  it("asks for an address when the client has none (or only a placeholder)", async () => {
    for (const clientEmail of [null, "sin-email+abc@kiraroom.invalid"]) {
      const { service, sent } = setup({ clientEmail });
      const err = await service.send(TENANT, "inv-1", ACTOR).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(sent).toHaveLength(0);
    }
  });

  it("does not send a cancelled invoice, nor another salon's", async () => {
    await expect(setup({ invoice: { status: "cancelled" } }).service.send(TENANT, "inv-1", ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(setup({ invoice: null }).service.send(TENANT, "inv-1", ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("says so when email is not configured, and when the provider fails (nothing logged)", async () => {
    await expect(setup({ configured: false }).service.send(TENANT, "inv-1", ACTOR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const failing = setup({ resendError: { message: "boom" } });
    await expect(failing.service.send(TENANT, "inv-1", ACTOR)).rejects.toBeInstanceOf(BadGatewayException);
    expect(failing.audit.record).not.toHaveBeenCalled();
  });
});

describe("InvoiceEmailService: the till's points block", () => {
  it("a till sale's invoice tells the client the points earned, her balance and the expiry rule", async () => {
    const { service, sent, prisma } = setup({ invoice: { sourceType: "pos_sale", sourceId: "sale-1" } });
    Object.assign(prisma as any, {
      posSale: { findFirst: jest.fn(async () => ({ id: "sale-1", clientId: "client-1", lines: [{ appointmentId: "apt-1" }] })) },
      loyaltyProgram: { findFirst: jest.fn(async () => ({ id: "prog-1", isActive: true, pointsExpirationDays: 365 })) },
      loyaltyMember: { findUnique: jest.fn(async () => ({ id: "m-1", currentPoints: 245, status: "active" })) },
      loyaltyTransaction: { findMany: jest.fn(async () => [{ points: 30 }]) },
    });
    await service.send(TENANT, "inv-1", ACTOR);
    const mail = sent[0];
    expect(mail.text).toContain("Puntos ganados con esta compra: 30 puntos");
    expect(mail.text).toContain("Tu saldo de puntos: 245 puntos");
    expect(mail.text).toContain("Tus puntos caducan si pasan 12 meses sin visitas.");
    expect(mail.html).toContain("Tu saldo de puntos: 245 puntos");
  });

  it("any other invoice, or a client who is not a member, has no points block", async () => {
    const plain = setup();
    await plain.service.send(TENANT, "inv-1", ACTOR);
    expect(plain.sent[0].text).not.toMatch(/puntos/i);

    const notMember = setup({ invoice: { sourceType: "pos_sale", sourceId: "sale-1" } });
    Object.assign(notMember.prisma as any, {
      posSale: { findFirst: jest.fn(async () => ({ id: "sale-1", clientId: "client-1", lines: [] })) },
      loyaltyProgram: { findFirst: jest.fn(async () => ({ id: "prog-1", isActive: true, pointsExpirationDays: 365 })) },
      loyaltyMember: { findUnique: jest.fn(async () => null) },
      loyaltyTransaction: { findMany: jest.fn(async () => []) },
    });
    await notMember.service.send(TENANT, "inv-1", ACTOR);
    expect(notMember.sent[0].text).not.toMatch(/puntos/i);
  });
});
