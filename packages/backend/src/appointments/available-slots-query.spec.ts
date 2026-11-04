import "reflect-metadata";
import { AppointmentsController } from "./appointments.controller";
import { queryParser } from "../common/validation/validated-body.testing";

/**
 * R1: the embeddable widget never showed a free time. It asks for the slots
 * with `duration=<minutes>` in the query; the query arrives as text, the
 * global ValidationPipe (main.ts, common/validation/global-validation-pipe.ts)
 * does no implicit conversion, and AvailableSlotsDto.duration had no @Type,
 * so "60" failed @IsNumber with a 400 and the widget showed "No hay huecos".
 * Run through the app's own pipe configuration and the type the controller
 * declares.
 */
const parse = queryParser(AppointmentsController, "getAvailableSlots");
const TENANT = "11111111-1111-4111-8111-111111111111";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const WIDGET = "44444444-4444-4444-8444-444444444444";

describe("GET /appointments/available-slots query", () => {
  it("accepts exactly what the widget sends, duration as a number", async () => {
    const q = await parse({ tenantId: TENANT, date: "2026-11-10", serviceId: SERVICE, duration: "60", widgetInstanceId: WIDGET });
    expect(q.duration).toBe(60);
    expect(q.widgetInstanceId).toBe(WIDGET);
  });

  it("accepts what the salon's page sends (no duration)", async () => {
    const q = await parse({ tenantId: TENANT, date: "2026-11-10", serviceId: SERVICE, professionalId: SERVICE });
    expect(q.duration).toBeUndefined();
  });

  it("still refuses a duration that is not a positive number", async () => {
    await expect(parse({ tenantId: TENANT, date: "2026-11-10", duration: "abc" })).rejects.toBeDefined();
    await expect(parse({ tenantId: TENANT, date: "2026-11-10", duration: "0" })).rejects.toBeDefined();
  });

  it("refuses a widget id that is not one", async () => {
    await expect(parse({ tenantId: TENANT, date: "2026-11-10", widgetInstanceId: "salon-1" })).rejects.toBeDefined();
  });
});
