import { OnboardingController } from "./onboarding.controller";
import { SubmitOnboardingWizardDto } from "./dto/onboarding-wizard.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

describe("POST /onboarding/wizard body", () => {
  const parse = bodyParser(OnboardingController, "submitWizard");

  /** What app/dashboard/onboarding/page.tsx submits. */
  const wizard = {
    services: [{ name: "Corte mujer", durationMinutes: 45, price: 25 }],
    workingHours: { mon: { open: "09:00", close: "19:00" }, sat: { open: "10:00", close: "14:00" } },
    firstAppointment: { clientName: "Ana López", serviceName: "Corte mujer", date: "2026-11-03", time: "10:30" },
  };

  it("is the validated class, not an inline type", () => {
    expect(bodyMetatype(OnboardingController, "submitWizard")).toBe(SubmitOnboardingWizardDto);
  });

  it("keeps the wizard's payload", async () => {
    expect(JSON.parse(JSON.stringify(await parse(wizard)))).toEqual(wizard);
  });

  it("keeps only the days of the week in the opening hours", async () => {
    const out = await parse({ workingHours: { mon: { open: "09:00", close: "19:00" }, timezone: "x", holidays: [] } });
    expect(JSON.parse(JSON.stringify(out.workingHours))).toEqual({ mon: { open: "09:00", close: "19:00" } });
  });

  it("refuses bad hours, durations and prices", async () => {
    await expect(parse({ workingHours: { mon: { open: "9", close: "19:00" } } })).rejects.toBeDefined();
    await expect(parse({ workingHours: { mon: "all day" } })).rejects.toBeDefined();
    await expect(parse({ services: [{ name: "Corte", durationMinutes: 0, price: 25 }] })).rejects.toBeDefined();
    await expect(parse({ services: [{ name: "Corte", durationMinutes: 30, price: -1 }] })).rejects.toBeDefined();
    await expect(parse({ firstAppointment: { ...wizard.firstAppointment, time: "25:00" } })).rejects.toBeDefined();
  });

  it("hands the service only the days that were sent", async () => {
    const submitWizard = jest.fn(async (..._args: any[]) => ({}));
    const c = new OnboardingController({ submitWizard } as any);
    const body = await parse({ workingHours: { mon: { open: "09:00", close: "19:00" } } });
    await c.submitWizard({ user: { tenantId: "t1" } } as any, body);
    expect(submitWizard.mock.calls[0][1].workingHours).toEqual({ mon: expect.objectContaining({ open: "09:00" }) });
  });

  it("takes the salon's week with shifts in the list format, normalised", async () => {
    const out = await parse({
      openingHours: [
        { day: "Monday", openTime: "16:00", closeTime: "20:00" },
        { day: "monday", openTime: "9:00", closeTime: "14:00" },
      ],
    });
    expect(out.openingHours).toEqual([
      { day: "monday", openTime: "09:00", closeTime: "14:00" },
      { day: "monday", openTime: "16:00", closeTime: "20:00" },
    ]);
  });

  it("refuses a shift that ends before it starts, or overlapping shifts, with the reason", async () => {
    await expect(
      parse({ openingHours: [{ day: "monday", openTime: "19:00", closeTime: "09:00" }] }),
    ).rejects.toBeDefined();
    await expect(
      parse({
        openingHours: [
          { day: "monday", openTime: "09:00", closeTime: "14:00" },
          { day: "monday", openTime: "13:00", closeTime: "18:00" },
        ],
      }),
    ).rejects.toBeDefined();
  });

  it("hands the service the week in the list format", async () => {
    const submitWizard = jest.fn(async (..._args: any[]) => ({}));
    const c = new OnboardingController({ submitWizard } as any);
    const openingHours = [{ day: "monday", openTime: "09:00", closeTime: "14:00" }];
    await c.submitWizard({ user: { tenantId: "t1" } } as any, await parse({ openingHours }));
    expect(submitWizard.mock.calls[0][1].openingHours).toEqual(openingHours);
  });
});
