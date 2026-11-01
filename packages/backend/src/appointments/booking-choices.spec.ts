import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AppointmentsService } from "./appointments.service";
import { OnlineBookingDto } from "./dto/book-appointment.dto";

/**
 * The two boxes of the booking page and the widget reach the booking:
 * recorded once the booking found or created the client, before the
 * confirmation goes out (so WhatsApp notices already apply to it). The
 * recording itself is ConsentService's (consent/booking-choices.spec.ts).
 */
function setup() {
  const order: string[] = [];
  const prisma: any = {
    $transaction: async (fn: any) => fn({ $executeRaw: jest.fn() }),
  };
  const consent = {
    recordBookingChoices: jest.fn(async () => {
      order.push("choices");
    }),
  };
  const stub = {} as any;
  const service = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, consent as any);
  const s = service as any;
  s.assertBookableOnline = jest.fn(async () => undefined);
  s.onlineBookingWindow = jest.fn(async () => ({ minHours: 0, maxHours: 24 * 60 }));
  s.fitsOnlineWindow = jest.fn(() => "ok");
  s.isSlotFree = jest.fn(async () => true);
  s.insertAppointment = jest.fn(async () => ({ id: "apt-1", clientId: "client-1" }));
  s.afterAppointmentCreated = jest.fn(async () => {
    order.push("confirmation");
    return { emailSent: true };
  });
  return { service, consent, order };
}

const BOOKING = {
  professionalId: "11111111-1111-4111-8111-111111111111",
  serviceId: "33333333-3333-4333-8333-333333333333",
  scheduledDate: "2026-11-10",
  scheduledTime: "10:00",
  clientInfo: { firstName: "Ana", lastName: "López", phone: "600 111 222" },
};

describe("online booking: what the client ticked", () => {
  it("records both boxes for the client the booking found, before the confirmation", async () => {
    const { service, consent, order } = setup();

    await service.bookOnline(
      "tenant-1",
      { ...BOOKING, source: "widget", refusesMarketingEmail: true, wantsWhatsAppNotices: true } as any,
      [],
      { ip: "1.2.3.4" },
    );

    expect(consent.recordBookingChoices).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      clientId: "client-1",
      appointmentId: "apt-1",
      source: "widget",
      ip: "1.2.3.4",
      typedPhone: "600 111 222",
      refusesMarketingEmail: true,
      wantsWhatsAppNotices: true,
    });
    expect(order).toEqual(["choices", "confirmation"]);
  });

  it("the salon's page is source \"booking\"; nothing ticked records nothing", async () => {
    const { service, consent } = setup();
    await service.bookOnline("tenant-1", BOOKING as any);
    expect(consent.recordBookingChoices).not.toHaveBeenCalled();

    await service.bookOnline("tenant-1", { ...BOOKING, source: "online", refusesMarketingEmail: true } as any);
    expect((consent.recordBookingChoices.mock.calls[0] as any[])[0]).toMatchObject({ source: "booking" });
  });

  it("a failure to record never fails the booking", async () => {
    const { service, consent } = setup();
    consent.recordBookingChoices.mockRejectedValueOnce(new Error("db down"));
    await expect(
      service.bookOnline("tenant-1", { ...BOOKING, wantsWhatsAppNotices: true } as any),
    ).resolves.toMatchObject({ id: "apt-1" });
  });

  it("the WhatsApp promotions box alone reaches the consent service too", async () => {
    const { service, consent } = setup();
    await service.bookOnline("tenant-1", { ...BOOKING, wantsWhatsAppPromotions: true } as any, [], { ip: "1.2.3.4" });
    expect((consent.recordBookingChoices.mock.calls[0] as any[])[0]).toMatchObject({
      source: "booking",
      typedPhone: "600 111 222",
      wantsWhatsAppPromotions: true,
    });
  });

  it("the boxes are optional booleans", () => {
    const promos = plainToInstance(OnlineBookingDto, { ...BOOKING, wantsWhatsAppPromotions: true });
    expect(validateSync(promos)).toEqual([]);
    const badPromos = plainToInstance(OnlineBookingDto, { ...BOOKING, wantsWhatsAppPromotions: "sí" });
    expect(validateSync(badPromos).map((e) => e.property)).toEqual(["wantsWhatsAppPromotions"]);
    const valid = plainToInstance(OnlineBookingDto, { ...BOOKING, refusesMarketingEmail: true, wantsWhatsAppNotices: false });
    expect(validateSync(valid)).toEqual([]);
    const invalid = plainToInstance(OnlineBookingDto, { ...BOOKING, refusesMarketingEmail: "yes" });
    expect(validateSync(invalid).map((e) => e.property)).toEqual(["refusesMarketingEmail"]);
  });
});
