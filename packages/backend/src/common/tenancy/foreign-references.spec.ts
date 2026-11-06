import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AppointmentsService } from "../../appointments/appointments.service";
import { ConsentService } from "../../consent/consent.service";
import { GiftCardsService } from "../../gift-cards/gift-cards.service";
import { InvoiceService } from "../../invoices/invoices.service";
import { UpsellController } from "../../upsell/upsell.controller";

/**
 * Audit 2026-11-06 (low findings): ids sent by the panel that point at
 * another salon's rows are refused instead of being written as dangling links.
 */
const nothing = { findFirst: async () => null, count: async () => 0, findUnique: async () => null };

describe("ids from another salon are refused", () => {
  it("a consent form tied to another salon's service", async () => {
    const svc: any = Object.create(ConsentService.prototype);
    svc.prisma = { service: nothing, consentForm: { create: jest.fn() } };
    await expect(
      svc.createForm("t1", { name: "F", fields: [{ k: 1 }], serviceIds: ["foreign"] }),
    ).rejects.toThrow(BadRequestException);
    expect(svc.prisma.consentForm.create).not.toHaveBeenCalled();
  });

  it("a manual invoice for another salon's client, product or service", async () => {
    const svc: any = Object.create(InvoiceService.prototype);
    svc.create = jest.fn();
    svc.prisma = {
      tenant: { findUnique: async () => ({ fiscalSettings: {}, timezone: "Europe/Madrid" }) },
      client: nothing,
      product: nothing,
      service: nothing,
    };
    const line = { description: "x", quantity: 1, unitPrice: 1000, taxRate: 21 };
    await expect(svc.createManual({ tenantId: "t1", recipientId: "foreign", lines: [line] })).rejects.toThrow(/clienta/);
    await expect(svc.createManual({ tenantId: "t1", lines: [{ ...line, productId: "foreign" }] })).rejects.toThrow(/producto/);
    await expect(svc.createManual({ tenantId: "t1", lines: [{ ...line, serviceId: "foreign" }] })).rejects.toThrow(/servicio/);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("a gift card for another salon's client, and a redeem against another salon's payment", async () => {
    const tx: any = { client: nothing, payment: nothing, giftCard: { updateMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() } };
    const svc: any = Object.create(GiftCardsService.prototype);
    svc.prisma = { $transaction: async (fn: any) => fn(tx) };
    svc.timeZoneOf = jest.fn(async () => "Europe/Madrid");
    await expect(svc.create("t1", { initialAmount: 1000, recipientId: "foreign" })).rejects.toThrow(NotFoundException);
    await expect(svc.redeem("t1", { giftCardId: "g", amount: 100, paymentId: "foreign" })).rejects.toThrow(NotFoundException);
    // Refused before anything is written.
    expect(tx.giftCard.create).not.toHaveBeenCalled();
    expect(tx.giftCard.updateMany).not.toHaveBeenCalled();
  });

  it("moving a service row to another salon's professional", async () => {
    const svc: any = Object.create(AppointmentsService.prototype);
    svc.loadVisit = jest.fn(async () => ({ services: [{ id: "row", start: new Date(), end: new Date(), professionalId: "p1" }] }));
    svc.staffVisitCheck = jest.fn(async () => null);
    svc.prisma = { professional: nothing };
    await expect(
      svc.moveVisitService({ tenantId: "t1", role: "owner" }, "row", { scope: "visit", minutesDelta: 5, professionalId: "foreign" }),
    ).rejects.toThrow("Profesional no encontrado");
  });

  it("upsell suggestions use the caller's salon, not ?tenantId=", async () => {
    const suggest = jest.fn(async () => []);
    await new UpsellController({ suggest } as any).suggest({ tenantId: "mine" }, "c1");
    expect(suggest).toHaveBeenCalledWith("mine", { clientId: "c1", excludeServiceIds: undefined });
  });
});
