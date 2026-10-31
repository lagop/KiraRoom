import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { AppointmentsController } from "./appointments.controller";
import { AppointmentsService } from "./appointments.service";
import { UpdateAppointmentPaymentDto } from "./dto/update-appointment-payment.dto";

/**
 * PATCH /appointments/:id/payment took an inline body nothing validated: a
 * professional could mark their own appointments paid for any amount, in
 * any unit, and the client earned points on it. It is now the owner's or a
 * manager's correction, with a checked body, never above the total (there
 * is no tip field), and it earns no points by itself (loyalty spec).
 */

const TENANT = "tenant-a";
const OWNER = { id: "u-owner", role: "owner", tenantId: TENANT };
const ADMIN = { id: "u-admin", role: "admin", tenantId: TENANT };
const STAFF = { id: "u-staff", role: "staff", tenantId: TENANT };

const errorsOf = (body: Record<string, unknown>) =>
  validateSync(plainToInstance(UpdateAppointmentPaymentDto, body), { whitelist: true }).map((e) => e.property);

describe("PATCH /appointments/:id/payment: the body", () => {
  it("accepts a payment status, a whole number of cents and a payment method", () => {
    expect(errorsOf({ status: "paid", amountPaid: 4550, paymentMethod: "card" })).toEqual([]);
    expect(errorsOf({ status: "refunded", amountPaid: 0 })).toEqual([]);
  });

  it("refuses anything else", () => {
    expect(errorsOf({ status: "settled", amountPaid: 100 })).toContain("status");
    expect(errorsOf({ status: "paid", amountPaid: -1 })).toContain("amountPaid");
    // Euros with decimals: the column is cents.
    expect(errorsOf({ status: "paid", amountPaid: 45.5 })).toContain("amountPaid");
    expect(errorsOf({ status: "paid", amountPaid: "4550" })).toContain("amountPaid");
    expect(errorsOf({ status: "paid" })).toContain("amountPaid");
    expect(errorsOf({ status: "paid", amountPaid: 100, paymentMethod: "bitcoin" })).toContain("paymentMethod");
  });

  it("is a class the ValidationPipe can see, not an inline type", () => {
    const [, , body] = Reflect.getMetadata("design:paramtypes", AppointmentsController.prototype, "updatePayment");
    expect(body).toBe(UpdateAppointmentPaymentDto);
  });
});

describe("PATCH /appointments/:id/payment: who and how much", () => {
  it("is for the owner and managers, not staff", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AppointmentsController.prototype.updatePayment) as UserRole[];
    expect(roles).toEqual(expect.arrayContaining([UserRole.owner, UserRole.admin]));
    expect(roles).not.toContain(UserRole.staff);
  });

  function build(apt: Record<string, unknown> = {}) {
    const row = {
      id: "a1",
      tenantId: TENANT,
      clientId: "c1",
      professionalId: "p1",
      status: "completed",
      paymentStatus: "pending",
      amountPaid: 0,
      totalAmount: 4550, // cents
      service: { price: 45.5 },
      ...apt,
    };
    const prisma: any = {
      appointment: {
        findUnique: jest.fn(async () => row),
        update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
      },
      professional: { findFirst: jest.fn(async () => ({ id: "p1" })) },
    };
    const stub = {} as any;
    const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
    return { svc, prisma };
  }

  it("refuses a staff member even on their own appointment, writing nothing", async () => {
    const { svc, prisma } = build();
    await expect(
      svc.updatePaymentStatus(STAFF, "a1", { status: "paid", amountPaid: 4550 } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("refuses more than the appointment's total: there is no tip field", async () => {
    const { svc, prisma } = build();
    const err = await svc
      .updatePaymentStatus(OWNER, "a1", { status: "paid", amountPaid: 4551 } as any)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain("45,50 €");
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("uses the service price (euros) when the appointment has no stored total", async () => {
    const { svc } = build({ totalAmount: 0, service: { price: 30 } });
    await expect(
      svc.updatePaymentStatus(ADMIN, "a1", { status: "paid", amountPaid: 3001 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.updatePaymentStatus(ADMIN, "a1", { status: "paid", amountPaid: 3000 } as any),
    ).resolves.toMatchObject({ paymentStatus: "paid" });
  });

  it("does not mark a cancelled or no-show appointment paid", async () => {
    for (const status of ["cancelled", "no_show"]) {
      const { svc, prisma } = build({ status });
      await expect(
        svc.updatePaymentStatus(OWNER, "a1", { status: "paid", amountPaid: 100 } as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.appointment.update).not.toHaveBeenCalled();
    }
    // A refund on a cancelled one is still a correction the owner can make.
    const { svc } = build({ status: "cancelled", paymentStatus: "paid", amountPaid: 4550 });
    await expect(
      svc.updatePaymentStatus(OWNER, "a1", { status: "refunded", amountPaid: 0 } as any),
    ).resolves.toMatchObject({ paymentStatus: "refunded" });
  });

  it("writes the checked values, in cents", async () => {
    const { svc, prisma } = build();
    await svc.updatePaymentStatus(OWNER, "a1", { status: "paid", amountPaid: 4550, paymentMethod: "cash" } as any);
    expect(prisma.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a1", tenantId: TENANT },
        data: expect.objectContaining({ paymentStatus: "paid", amountPaid: 4550, paymentMethod: "cash" }),
      }),
    );
  });
});
