import { ConflictException, HttpException } from "@nestjs/common";
import { AppointmentStatus } from "@prisma/client";
import { AppointmentsService } from "./appointments.service";
import { AppointmentServicesService } from "./appointment-services.service";
import {
  APPOINTMENT_STATUS_TRANSITIONS,
  applyStatusIfAllowed,
  assertTransition,
  canTransition,
  needsConsent,
  transitionRefusal,
} from "./appointment-status";
import { PaymentsService } from "../payments/payments.service";
import { SalonCopilotToolsService } from "../assistant/tools/salon-copilot-tools";

/**
 * Appointment status changes. The panel changed the status with a plain
 * PATCH, so cancelling sent no notice and told no wait-list, completing
 * issued no invoice, and nothing stopped a cancelled appointment from
 * becoming completed or a visit from being completed (and invoiced) twice.
 * Now one table says what may follow what, and every route takes the same
 * path: checked before writing, written only over the status it was checked
 * against, followed by the same side effects.
 */

const S = AppointmentStatus;
const ALL = Object.values(AppointmentStatus) as AppointmentStatus[];
const DAY_MS = 24 * 3_600_000;

describe("the transition table", () => {
  it("has a row for every status, naming only real statuses", () => {
    expect(Object.keys(APPOINTMENT_STATUS_TRANSITIONS).sort()).toEqual([...ALL].sort());
    for (const to of Object.values(APPOINTMENT_STATUS_TRANSITIONS).flat()) {
      expect(ALL).toContain(to);
    }
  });

  it("never 'changes' a status to itself", () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
  });

  it("lets an open appointment be confirmed, started, completed, cancelled or missed", () => {
    for (const to of [S.confirmed, S.in_progress, S.completed, S.cancelled, S.no_show]) {
      expect(canTransition(S.pending, to)).toBe(true);
    }
    for (const to of [S.in_progress, S.completed, S.cancelled, S.no_show]) {
      expect(canTransition(S.confirmed, to)).toBe(true);
    }
    expect(canTransition(S.confirmed, S.pending)).toBe(false);
  });

  it("does not call a client already in the chair a no-show", () => {
    expect(canTransition(S.in_progress, S.no_show)).toBe(false);
    expect(canTransition(S.in_progress, S.completed)).toBe(true);
    expect(canTransition(S.in_progress, S.confirmed)).toBe(true); // a start pressed too early
  });

  it("keeps completed and cancelled final", () => {
    for (const to of ALL) {
      expect(canTransition(S.completed, to)).toBe(false);
      expect(canTransition(S.cancelled, to)).toBe(false);
    }
  });

  it("lets a no-show be undone to confirmed, and nothing else", () => {
    expect(APPOINTMENT_STATUS_TRANSITIONS[S.no_show]).toEqual([S.confirmed]);
  });

  it("refuses with a 409 and the reason in Spanish", () => {
    expect(() => assertTransition(S.cancelled, S.completed)).toThrow(ConflictException);
    expect(transitionRefusal(S.cancelled, S.completed)).toBe("Una cita cancelada no puede pasar a completada.");
    expect(transitionRefusal(S.completed, S.completed)).toBe("La cita ya está completada.");
    try {
      assertTransition(S.completed, S.cancelled);
    } catch (err) {
      expect((err as HttpException).getStatus()).toBe(409);
      expect((err as HttpException).getResponse()).toMatchObject({
        code: "INVALID_STATUS_TRANSITION",
        message: "Una cita completada no puede pasar a cancelada.",
      });
    }
  });

  it("asks for consent on the way into a visit, once", () => {
    expect(needsConsent(S.pending, S.confirmed)).toBe(true);
    expect(needsConsent(S.pending, S.completed)).toBe(true); // skipping "confirmed" skips nothing
    expect(needsConsent(S.no_show, S.confirmed)).toBe(true);
    expect(needsConsent(S.confirmed, S.completed)).toBe(false);
    expect(needsConsent(S.pending, S.cancelled)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

interface Built {
  service: AppointmentsService;
  row: any;
  prisma: any;
  sent: Record<string, jest.Mock>;
  waitList: { onAppointmentCancelled: jest.Mock };
  invoice: { fromAppointment: jest.Mock };
  cadence: { computeForClient: jest.Mock };
  consent: { hasValidConsent: jest.Mock; getRequiredForms: jest.Mock };
}

/** An appointment in a fake database, with every notice and job spied on. */
function build(
  status: AppointmentStatus,
  opts: { startsInMs?: number; consentSigned?: boolean } = {},
): Built {
  const start = new Date(Date.now() + (opts.startsInMs ?? 3 * DAY_MS));
  const row: any = {
    id: "apt-1",
    tenantId: "t1",
    clientId: "c1",
    serviceId: "s1",
    professionalId: "p1",
    status,
    duration: 60,
    notes: null,
    // UTC day and time, read in a UTC salon.
    scheduledDate: new Date(`${start.toISOString().slice(0, 10)}T00:00:00.000Z`),
    scheduledTime: start.toISOString().slice(11, 16),
    startTime: null,
    tenant: { timezone: "UTC", minCancelHours: 24 },
    services: [],
  };
  const prisma: any = {
    appointment: {
      findUnique: jest.fn(async () => ({ ...row })),
      update: jest.fn(async ({ where, data }: any) => {
        // Prisma's extended where: no row when the status moved on.
        if (where.status !== undefined && where.status !== row.status) {
          throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        }
        Object.assign(row, data);
        return { ...row };
      }),
    },
    appointmentService: { deleteMany: jest.fn(), createMany: jest.fn() },
    service: { count: jest.fn(async ({ where }: any) => where.id.in.length) },
  };
  const waitList = { onAppointmentCancelled: jest.fn(async () => []) };
  const invoice = { fromAppointment: jest.fn(async () => ({})) };
  const cadence = { computeForClient: jest.fn(async () => ({})) };
  const consent = {
    hasValidConsent: jest.fn(async () => opts.consentSigned ?? true),
    getRequiredForms: jest.fn(async () => [{ id: "f1", name: "Tinte", version: 2 }]),
  };
  const stub = {} as any;
  const service = new AppointmentsService(
    prisma, stub, stub, stub, stub, stub, stub, consent as any,
    cadence as any, invoice as any, waitList as any,
  );
  const sent: Record<string, jest.Mock> = {};
  for (const m of [
    "sendAppointmentCancelledNotifications",
    "sendAppointmentCompletedNotifications",
    "sendAppointmentNoShowNotifications",
    "sendAppointmentConfirmedNotifications",
    "sendAppointmentRescheduledNotifications",
    "logAppointmentActivity",
  ]) {
    sent[m] = jest.fn(async () => undefined);
    (service as any)[m] = sent[m];
  }
  return { service, row, prisma, sent, waitList, invoice, cadence, consent };
}

const OWNER = { id: "u1", role: "owner", tenantId: "t1" };

describe("the dedicated endpoints", () => {
  it("complete: writes over the status it read, invoices, recomputes the cadence, tells the client", async () => {
    const b = build(S.confirmed);
    await b.service.complete(OWNER, "apt-1", "Mechas");
    const write = b.prisma.appointment.update.mock.calls[0][0];
    expect(write.where).toEqual({ id: "apt-1", tenantId: OWNER.tenantId, status: S.confirmed });
    expect(write.data).toMatchObject({ status: S.completed, notes: "Mechas" });
    expect(write.data.completionTime).toBeInstanceOf(Date);
    expect(b.invoice.fromAppointment).toHaveBeenCalledWith("apt-1");
    expect(b.cadence.computeForClient).toHaveBeenCalledWith("c1");
    expect(b.sent.sendAppointmentCompletedNotifications).toHaveBeenCalledTimes(1);
  });

  it("complete: recomputes the client's visits; a cancellation does not touch them", async () => {
    const withStats = (b: Built) => {
      b.prisma.client = {
        findFirst: jest.fn(async () => ({ createdAt: new Date("2025-01-01") })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      };
      b.prisma.appointment.aggregate = jest.fn(async () => ({
        _count: { _all: 1 },
        _min: { scheduledDate: b.row.scheduledDate },
        _max: { scheduledDate: b.row.scheduledDate },
      }));
      b.prisma.payment = { aggregate: jest.fn(async () => ({ _sum: { amount: null } })) };
      return b;
    };
    const done = withStats(build(S.confirmed));
    await done.service.complete(OWNER, "apt-1");
    expect(done.prisma.client.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", tenantId: "t1" },
      data: expect.objectContaining({ visitCount: 1, lastVisit: done.row.scheduledDate }),
    });

    const cancelled = withStats(build(S.confirmed));
    await cancelled.service.cancel(OWNER, "apt-1");
    expect(cancelled.prisma.client.updateMany).not.toHaveBeenCalled();
  });

  it("complete twice: the second is a 409 and there is one invoice", async () => {
    const b = build(S.confirmed);
    await b.service.complete(OWNER, "apt-1");
    await expect(b.service.complete(OWNER, "apt-1")).rejects.toThrow("La cita ya está completada.");
    expect(b.invoice.fromAppointment).toHaveBeenCalledTimes(1);
  });

  it("two completes at once: the one that loses the race is a 409 with no side effects", async () => {
    const b = build(S.confirmed);
    // Both read "confirmed"; the other request writes first.
    b.prisma.appointment.update.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
    });
    await expect(b.service.complete(OWNER, "apt-1")).rejects.toMatchObject({
      response: { code: "STATUS_CHANGED" },
    });
    expect(b.invoice.fromAppointment).not.toHaveBeenCalled();
    expect(b.sent.sendAppointmentCompletedNotifications).not.toHaveBeenCalled();
  });

  it("a cancelled appointment cannot be completed or marked no-show", async () => {
    const b = build(S.cancelled);
    await expect(b.service.complete(OWNER, "apt-1")).rejects.toThrow(ConflictException);
    await expect(b.service.markNoShow(OWNER, "apt-1")).rejects.toThrow(ConflictException);
    expect(b.prisma.appointment.update).not.toHaveBeenCalled();
    expect(b.invoice.fromAppointment).not.toHaveBeenCalled();
  });

  it("a completed one cannot be cancelled", async () => {
    const b = build(S.completed);
    await expect(b.service.cancel(OWNER, "apt-1")).rejects.toThrow(
      "Una cita completada no puede pasar a cancelada.",
    );
    expect(b.prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("cancel: keeps the reason, tells the client and the wait-list for a future slot", async () => {
    const b = build(S.confirmed);
    await b.service.cancel(OWNER, "apt-1", "Enferma");
    expect(b.prisma.appointment.update.mock.calls[0][0].data).toMatchObject({
      status: S.cancelled,
      cancellationReason: "Enferma",
    });
    expect(b.sent.sendAppointmentCancelledNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ id: "apt-1" }),
      "Enferma",
    );
    expect(b.waitList.onAppointmentCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", serviceId: "s1", professionalId: "p1" }),
    );
  });

  it("cancel: a slot already past goes to nobody on the wait-list", async () => {
    const b = build(S.confirmed, { startsInMs: -2 * 3_600_000 });
    await b.service.cancel(OWNER, "apt-1");
    expect(b.sent.sendAppointmentCancelledNotifications).toHaveBeenCalledTimes(1);
    expect(b.waitList.onAppointmentCancelled).not.toHaveBeenCalled();
  });

  it("the salon may cancel an hour before: the notice window was the client's, and clients have no accounts", async () => {
    const b = build(S.confirmed, { startsInMs: 3_600_000 });
    await b.service.cancel(OWNER, "apt-1");
    expect(b.row.status).toBe(S.cancelled);
  });

  it("no-show: tells the client; can be undone to confirmed", async () => {
    const b = build(S.confirmed, { startsInMs: -3_600_000 });
    await b.service.markNoShow(OWNER, "apt-1");
    expect(b.row.status).toBe(S.no_show);
    expect(b.sent.sendAppointmentNoShowNotifications).toHaveBeenCalledTimes(1);

    await b.service.changeStatus(OWNER, "apt-1", S.confirmed);
    expect(b.row.status).toBe(S.confirmed);
  });

  it("completing straight from pending still needs the consent forms, checked before writing", async () => {
    const b = build(S.pending, { consentSigned: false });
    await expect(b.service.complete(OWNER, "apt-1")).rejects.toMatchObject({
      response: { code: "CONSENT_REQUIRED" },
    });
    expect(b.prisma.appointment.update).not.toHaveBeenCalled();
    expect(b.invoice.fromAppointment).not.toHaveBeenCalled();
  });
});

describe("PATCH /appointments/:id with a status", () => {
  it("cancelled behaves like cancel, reason included", async () => {
    const b = build(S.confirmed);
    await b.service.update(OWNER, "apt-1", {
      status: S.cancelled,
      cancellationReason: "Viaje",
    } as any);
    const write = b.prisma.appointment.update.mock.calls[0][0];
    expect(write.where).toEqual({ id: "apt-1", tenantId: OWNER.tenantId, status: S.confirmed });
    expect(write.data).toMatchObject({ status: S.cancelled, cancellationReason: "Viaje" });
    expect(b.sent.sendAppointmentCancelledNotifications).toHaveBeenCalledWith(expect.anything(), "Viaje");
    expect(b.waitList.onAppointmentCancelled).toHaveBeenCalledTimes(1);
  });

  it("completed behaves like complete: invoice, cadence, completion time", async () => {
    const b = build(S.in_progress);
    await b.service.update(OWNER, "apt-1", { status: S.completed } as any);
    expect(b.prisma.appointment.update.mock.calls[0][0].data.completionTime).toBeInstanceOf(Date);
    expect(b.invoice.fromAppointment).toHaveBeenCalledTimes(1);
    expect(b.cadence.computeForClient).toHaveBeenCalledTimes(1);
    expect(b.sent.sendAppointmentCompletedNotifications).toHaveBeenCalledTimes(1);
  });

  it("no_show behaves like the no-show endpoint", async () => {
    const b = build(S.confirmed);
    await b.service.update(OWNER, "apt-1", { status: S.no_show } as any);
    expect(b.sent.sendAppointmentNoShowNotifications).toHaveBeenCalledTimes(1);
  });

  it("an illegal change is a 409 and nothing is written, services included", async () => {
    const b = build(S.cancelled);
    await expect(
      b.service.update(OWNER, "apt-1", {
        status: S.completed,
        services: [{ serviceId: "s1" }],
      } as any),
    ).rejects.toThrow("Una cita cancelada no puede pasar a completada.");
    expect(b.prisma.appointment.update).not.toHaveBeenCalled();
    expect(b.prisma.appointmentService.deleteMany).not.toHaveBeenCalled();
  });

  it("confirming without the consent forms is a 409 before anything changes", async () => {
    const b = build(S.pending, { consentSigned: false });
    await expect(b.service.update(OWNER, "apt-1", { status: S.confirmed } as any)).rejects.toMatchObject({
      response: { code: "CONSENT_REQUIRED", requiredConsents: [{ id: "f1", name: "Tinte", version: 2 }] },
    });
    expect(b.prisma.appointment.update).not.toHaveBeenCalled();
    expect(b.row.status).toBe(S.pending);
    expect(b.sent.sendAppointmentConfirmedNotifications).not.toHaveBeenCalled();
  });

  it("confirming with them signed sends the confirmation", async () => {
    const b = build(S.pending);
    await b.service.update(OWNER, "apt-1", { status: S.confirmed } as any);
    expect(b.row.status).toBe(S.confirmed);
    expect(b.sent.sendAppointmentConfirmedNotifications).toHaveBeenCalledTimes(1);
  });

  it("the form resending the status it shows is not a change", async () => {
    const b = build(S.completed);
    await b.service.update(OWNER, "apt-1", { status: S.completed, notes: "Le gustó" } as any);
    const write = b.prisma.appointment.update.mock.calls[0][0];
    expect(write.where).toEqual({ id: "apt-1", tenantId: OWNER.tenantId });
    expect(write.data.status).toBeUndefined();
    expect(write.data.notes).toBe("Le gustó");
    expect(b.invoice.fromAppointment).not.toHaveBeenCalled();
  });
});

describe("the other callers", () => {
  it("a visit whose services are all done completes through the same path", async () => {
    const prisma: any = {
      appointmentService: {
        findFirst: jest.fn(async () => ({ id: "row-1", appointmentId: "apt-1" })),
        update: jest.fn(async () => ({ id: "row-1", appointmentId: "apt-1" })),
        count: jest.fn(async () => 0),
      },
      appointment: { findFirst: jest.fn(async () => ({ status: S.in_progress, tenantId: "t1" })) },
    };
    const appointments = { changeStatus: jest.fn(async () => ({})) };
    const svc = new AppointmentServicesService(prisma, appointments as any);
    await svc.completeService("row-1", OWNER);
    expect(appointments.changeStatus).toHaveBeenCalledWith(
      { role: "system", tenantId: "t1" },
      "apt-1",
      S.completed,
    );
  });

  it("…but not a cancelled one, nor one already completed", async () => {
    for (const status of [S.cancelled, S.completed]) {
      const prisma: any = {
        appointmentService: {
          findFirst: jest.fn(async () => ({ id: "row-1", appointmentId: "apt-1" })),
          update: jest.fn(async () => ({ id: "row-1", appointmentId: "apt-1" })),
          count: jest.fn(async () => 0),
        },
        appointment: { findFirst: jest.fn(async () => ({ status, tenantId: "t1" })) },
      };
      const appointments = { changeStatus: jest.fn() };
      await new AppointmentServicesService(prisma, appointments as any).completeService("row-1", OWNER);
      expect(appointments.changeStatus).not.toHaveBeenCalled();
    }
  });

  it("the copilot's no-show goes through it, fee included, and is refused on a finished visit", async () => {
    const b = build(S.confirmed, { startsInMs: -3_600_000 });
    const copilot = new SalonCopilotToolsService(b.prisma, undefined, b.service);
    const ctx = { prisma: b.prisma, tenantId: "t1", userId: "u1", role: "owner" as any };
    const res = await copilot.execute("mark_no_show", { appointmentId: "apt-1", applyFee: true, feeAmount: 15 }, ctx);
    expect(res).toMatchObject({ ok: true, status: S.no_show, feeApplied: true });
    expect(b.prisma.appointment.update.mock.calls[0][0].data).toMatchObject({
      status: S.no_show,
      discount: { noShowFee: 15 },
    });
    expect(b.sent.sendAppointmentNoShowNotifications).toHaveBeenCalledTimes(1);

    const done = build(S.completed);
    const refused = await new SalonCopilotToolsService(done.prisma, undefined, done.service).execute(
      "mark_no_show",
      { appointmentId: "apt-1" },
      { ...ctx, prisma: done.prisma },
    );
    expect(refused).toMatchObject({
      error: "invalid_status",
      message: "Una cita completada no puede pasar a marcada como no presentada.",
    });
    expect(done.prisma.appointment.update).not.toHaveBeenCalled();
  });
});

describe("a payment marking its appointment", () => {
  function db(status: AppointmentStatus, count = 1) {
    return {
      appointment: {
        findUnique: jest.fn(async () => ({ status })),
        findFirst: jest.fn(async () => ({ id: "apt-1", status })),
        updateMany: jest.fn(async () => ({ count })),
        update: jest.fn(),
      },
      payment: {
        create: jest.fn(async ({ data }: any) => ({ id: "pay-1", ...data })),
      },
      client: { findFirst: jest.fn(async () => ({ id: "c1" })) },
    };
  }

  it("completes a confirmed appointment, over the status it read", async () => {
    const prisma = db(S.confirmed);
    expect(await applyStatusIfAllowed(prisma as any, "apt-1", S.completed)).toBe(true);
    expect(prisma.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: "apt-1", status: S.confirmed },
      data: { status: S.completed },
    });
  });

  it("leaves a completed, cancelled or no-show appointment as it is", async () => {
    for (const status of [S.completed, S.cancelled, S.no_show]) {
      const prisma = db(status);
      expect(await applyStatusIfAllowed(prisma as any, "apt-1", S.completed)).toBe(false);
      expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
    }
  });

  it("reports a status that moved on in between", async () => {
    expect(await applyStatusIfAllowed(db(S.confirmed, 0) as any, "apt-1", S.completed)).toBe(false);
  });

  // PATCH /payments/:id/status (updatePaymentStatus) is gone: a payment
  // recorded as paid is the one path left that marks its appointment.
  const paid = { clientId: "c1", appointmentId: "apt-1", amount: 100, method: "cash" as const, status: "paid" as const };

  it("PaymentsService: paying a confirmed appointment still completes it", async () => {
    const prisma = db(S.confirmed);
    await new PaymentsService(prisma as any).createPayment("t1", null, paid);
    expect(prisma.payment.create).toHaveBeenCalled();
    expect(prisma.appointment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: S.completed } }),
    );
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("PaymentsService: a payment on a cancelled appointment is recorded and the appointment stays cancelled", async () => {
    const prisma = db(S.cancelled);
    const payment = await new PaymentsService(prisma as any).createPayment("t1", null, paid);
    expect(payment).toMatchObject({ status: "paid" });
    expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
  });
});
