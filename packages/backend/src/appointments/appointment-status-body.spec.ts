import "reflect-metadata";
import { ArgumentMetadata, BadRequestException, ValidationPipe } from "@nestjs/common";
import { AppointmentsController } from "./appointments.controller";
import {
  CANCEL_REASON_MAX,
  COMPLETION_NOTES_MAX,
  CancelAppointmentDto,
  CompleteAppointmentDto,
} from "./dto/appointment-status.dto";

/**
 * The bodies of PUT /appointments/:id/cancel and /complete. They were read as
 * a bare `@Body("reason")` / `@Body("notes")`, which the ValidationPipe does
 * not check: any type and any length went into the appointment, and the
 * reason into the client's cancellation notice.
 */
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });

const bodyType = (method: "cancel" | "complete"): unknown =>
  Reflect.getMetadata("design:paramtypes", AppointmentsController.prototype, method)[2];

const parse = (method: "cancel" | "complete", body: unknown) =>
  pipe.transform(body, { type: "body", metatype: bodyType(method) as any } as ArgumentMetadata);

describe("PUT /appointments/:id/cancel and /complete bodies", () => {
  it("are validated classes", () => {
    expect(bodyType("cancel")).toBe(CancelAppointmentDto);
    expect(bodyType("complete")).toBe(CompleteAppointmentDto);
  });

  it("take a reason up to 1000 characters, and refuse a longer one", async () => {
    expect(CANCEL_REASON_MAX).toBe(1000);
    await expect(parse("cancel", { reason: "a".repeat(1000) })).resolves.toMatchObject({ reason: "a".repeat(1000) });
    await expect(parse("cancel", { reason: "a".repeat(1001) })).rejects.toThrow(BadRequestException);
  });

  it("take notes up to 5000 characters, and refuse longer ones", async () => {
    expect(COMPLETION_NOTES_MAX).toBe(5000);
    await expect(parse("complete", { notes: "n".repeat(5000) })).resolves.toMatchObject({ notes: "n".repeat(5000) });
    await expect(parse("complete", { notes: "n".repeat(5001) })).rejects.toThrow(BadRequestException);
  });

  it("refuse what is not text", async () => {
    await expect(parse("cancel", { reason: { $gt: "" } })).rejects.toThrow(BadRequestException);
    await expect(parse("complete", { notes: ["x"] })).rejects.toThrow(BadRequestException);
  });

  it("are optional, as the panel sends them", async () => {
    await expect(parse("cancel", {})).resolves.toEqual({});
    await expect(parse("complete", {})).resolves.toEqual({});
    // JSON.stringify({ reason: undefined }) is "{}"; null is accepted too.
    await expect(parse("cancel", { reason: null })).resolves.toMatchObject({ reason: null });
  });

  it("reach the service as before", async () => {
    const svc: any = { cancel: jest.fn(async () => ({})), complete: jest.fn(async () => ({})) };
    const c = new AppointmentsController(svc, {} as any);
    const req = { user: { id: "u1", role: "owner", tenantId: "t1" } };
    await c.cancel(req, "apt-1", (await parse("cancel", { reason: "Enferma" })) as CancelAppointmentDto);
    await c.complete(req, "apt-1", (await parse("complete", { notes: "Mechas" })) as CompleteAppointmentDto);
    expect(svc.cancel).toHaveBeenCalledWith(req.user, "apt-1", "Enferma");
    expect(svc.complete).toHaveBeenCalledWith(req.user, "apt-1", "Mechas");
  });
});
