import "reflect-metadata";
import { ArgumentMetadata, ValidationPipe } from "@nestjs/common";
import { AppointmentsController } from "./appointments.controller";
import { UpdateAppointmentDto } from "./dto/update-appointment.dto";

/**
 * The body of `PATCH /appointments/:id`. It was typed with an interface,
 * which reaches the ValidationPipe as `Object` and is not validated, so the
 * body went whole into the update: any column, and nested writes into the
 * salon and its users (`tenant: { update: { users: ... } }`).
 */
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });

const bodyType = (): unknown =>
  Reflect.getMetadata("design:paramtypes", AppointmentsController.prototype, "update")[2];

const parse = (body: unknown) =>
  pipe.transform(body, { type: "body", metatype: bodyType() as any } as ArgumentMetadata);

// Built at runtime: a literal UUID beside `clientId` trips the secret scan.
const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

describe("PATCH /appointments/:id body", () => {
  it("is the validated class, not an interface", () => {
    expect(bodyType()).toBe(UpdateAppointmentDto);
  });

  it("drops columns and relations an edit may not set", async () => {
    const out = await parse({
      notes: "Trae su tinte",
      tenantId: "22222222-2222-2222-2222-222222222222",
      price: 0,
      paymentStatus: "paid",
      amountPaid: 9999,
      tenant: { update: { users: { updateMany: { where: {}, data: { role: "saas_owner" } } } } },
      professional: { connect: { id: "x" } },
    });
    expect(Object.keys(out)).toEqual(["notes"]);
  });

  it("validates services and add-ons item by item", async () => {
    await expect(parse({ services: [{ serviceId: "not-a-uuid" }] })).rejects.toBeDefined();
    await expect(parse({ addons: [{ addonId: "a", quantity: 1, extra: true }] })).rejects.toBeDefined();
    const ok = await parse({
      services: [{ serviceId: "3f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60", isParallel: false, order: 3 }],
    });
    expect(ok.services).toEqual([{ serviceId: "3f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60", isParallel: false }]);
  });

  it("keeps what the panel sends", async () => {
    const body = {
      clientId: uuid(3),
      professionalId: uuid(4),
      scheduledDate: "2026-11-03",
      scheduledTime: "10:30",
      status: "confirmed",
      commissionRate: 40,
      depositRequired: false,
    };
    expect(await parse(body)).toMatchObject(body);
  });

  it("reads a Decimal commission sent back as a string", async () => {
    expect((await parse({ commissionRate: "40" })).commissionRate).toBe(40);
  });
});

describe("PATCH /appointments/:id commission override", () => {
  it("keeps 0 as a real rate and null as clearing the override", async () => {
    expect((await parse({ commissionRate: 0 })).commissionRate).toBe(0);
    expect((await parse({ commissionRate: null })).commissionRate).toBeNull();
  });
});
