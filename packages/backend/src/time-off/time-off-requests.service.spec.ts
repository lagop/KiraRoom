import { randomUUID } from "crypto";
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { TimeOffService, TimeOffUser } from "./time-off.service";
import { TimeOffRequestsService } from "./time-off-requests.service";
import { TimeOffController } from "./time-off.controller";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { bodyParser } from "../common/validation/validated-body.testing";

/**
 * Time off a professional asks for (/time-off/requests) and the salon's
 * answer (/time-off/:id/approve, /reject).
 *
 * The request is always for the caller's own professional record, from the
 * session; it blocks nothing until approved; both sides are told in the
 * panel's notifications (mocked here: nothing is sent anywhere).
 */

const TENANT = "tenant-a";
const OTHER = "tenant-b";
// Built at runtime: ids are UUIDs to the DTOs, and literals next to id keys
// read as secrets to the scanner.
const ANA = randomUUID();
const BEA = randomUUID();
const DAY = "2026-12-14";

const OWNER: TimeOffUser = { id: "u-owner", tenantId: TENANT, role: "owner" };
const ADMIN: TimeOffUser = { id: "u-admin", tenantId: TENANT, role: "admin" };
const ANA_USER: TimeOffUser = { id: "u-ana", tenantId: TENANT, role: "staff" };
const BEA_USER: TimeOffUser = { id: "u-bea", tenantId: TENANT, role: "staff" };
const UNLINKED: TimeOffUser = { id: "u-nobody", tenantId: TENANT, role: "staff" };

/** Whether a row satisfies the parts of a Prisma `where` these services use. */
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    const value = key === "status" ? (row.status ?? "approved") : row[key];
    if (cond === undefined) return true;
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("not" in cond) return value !== cond.not && value !== undefined;
      if ("lte" in cond || "gte" in cond) {
        return (cond.lte === undefined || value <= cond.lte) && (cond.gte === undefined || value >= cond.gte);
      }
    }
    return value === cond;
  });
}

function build(opts: { timeOff?: any[]; appointments?: any[]; notifyFails?: boolean } = {}) {
  const people: Record<string, any> = {
    [ANA]: { id: ANA, userId: ANA_USER.id, firstName: "Ana", lastName: "Gil", tenantId: TENANT },
    [BEA]: { id: BEA, userId: BEA_USER.id, firstName: "Bea", lastName: "Ruiz", tenantId: TENANT },
  };
  const users = [
    { id: OWNER.id, tenantId: TENANT, role: "owner", isActive: true },
    { id: ADMIN.id, tenantId: TENANT, role: "admin", isActive: true },
    { id: "u-old-admin", tenantId: TENANT, role: "admin", isActive: false },
    { id: ANA_USER.id, tenantId: TENANT, role: "staff", isActive: true },
    { id: "u-elsewhere", tenantId: OTHER, role: "owner", isActive: true },
  ];
  const rows: any[] = [...(opts.timeOff ?? [])];
  const withPro = (r: any) => (r ? { ...r, professional: r.professionalId ? people[r.professionalId] : null } : null);
  const appointments = (opts.appointments ?? []).map((a) => ({
    tenantId: TENANT,
    status: "confirmed",
    services: [],
    scheduledDate: new Date(`${DAY}T00:00:00.000Z`),
    client: { firstName: "Lucía", lastName: "Pérez" },
    service: { name: "Corte" },
    professional: people[a.professionalId],
    ...a,
  }));
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => ({ timezone: "Europe/Madrid" })) },
    user: { findMany: jest.fn(async ({ where }: any) => users.filter((u) => matches(u, where))) },
    professional: {
      findFirst: jest.fn(async ({ where }: any) =>
        Object.values(people).find((p) => matches(p, where)) ?? null,
      ),
    },
    appointment: {
      findMany: jest.fn(async ({ where }: any) =>
        appointments.filter(
          (a) =>
            a.tenantId === where.tenantId &&
            where.status.in.includes(a.status) &&
            (!where.OR || a.professionalId === where.OR[0].professionalId),
        ),
      ),
    },
    timeOff: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.push(row);
        return withPro(row);
      }),
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).map(withPro)),
      findFirst: jest.fn(async ({ where }: any) => withPro(rows.find((r) => matches(r, where)))),
      count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const i = rows.findIndex((r) => matches(r, where));
        if (i === -1) return { count: 0 };
        rows.splice(i, 1);
        return { count: 1 };
      }),
    },
  };
  const notifications = {
    create: jest.fn(async (dto: any) => {
      if (opts.notifyFails) throw new Error("socket down");
      return { id: randomUUID(), ...dto };
    }),
  };
  const timeOff = new TimeOffService(prisma);
  const service = new TimeOffRequestsService(prisma, timeOff, notifications as any);
  return { service, timeOff, prisma, rows, notifications };
}

const stored = (r: Record<string, unknown>) => ({
  id: randomUUID(),
  tenantId: TENANT,
  professionalId: ANA,
  kind: "vacation",
  status: "pending",
  requestedById: ANA_USER.id,
  createdById: ANA_USER.id,
  startDate: new Date(`${DAY}T00:00:00.000Z`),
  endDate: new Date(`${DAY}T00:00:00.000Z`),
  startTime: null,
  endTime: null,
  note: null,
  decisionNote: null,
  decidedAt: null,
  ...r,
});

const request = (r: Record<string, unknown> = {}) =>
  ({ kind: "vacation", startDate: DAY, endDate: "2026-12-16", ...r }) as any;

describe("asking for time off", () => {
  it("is always for the caller's own professional, whatever the body says", async () => {
    const { service, rows } = build();
    const out = await service.create(ANA_USER, request({ professionalId: BEA, note: "Boda" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT,
      professionalId: ANA,
      status: "pending",
      requestedById: ANA_USER.id,
      createdById: ANA_USER.id,
      note: "Boda",
    });
    expect(out.timeOff).toMatchObject({ professionalId: ANA, status: "pending", note: "Boda", requested: true });
  });

  it("the ValidationPipe drops a professional, a status or a salon sent in the body", async () => {
    const parse = bodyParser(TimeOffController, "createRequest");
    const body = await parse({ ...request(), professionalId: BEA, status: "approved", tenantId: OTHER });
    expect(body).not.toHaveProperty("professionalId");
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("tenantId");
  });

  it("refuses closures and sick leave, and the usual malformed bodies", async () => {
    const parse = bodyParser(TimeOffController, "createRequest");
    const refusal = (p: Promise<any>) =>
      p.then(
        () => null,
        (e) => {
          expect(e).toBeInstanceOf(BadRequestException);
          return ([] as string[]).concat((e.getResponse() as any).message).join(" | ");
        },
      );
    expect(await refusal(parse(request()))).toBeNull();
    expect(await refusal(parse(request({ endDate: DAY, startTime: "10:00", endTime: "12:00" })))).toBeNull();
    expect(await refusal(parse(request({ kind: "closure" })))).toMatch(/responsable/);
    expect(await refusal(parse(request({ kind: "sick_leave" })))).toMatch(/responsable/);
    expect(await refusal(parse(request({ startTime: "10:00", endTime: "12:00" })))).toMatch(/un único día/);
    expect(await refusal(parse(request({ endDate: "2026-12-01" })))).toMatch(/anterior/);
    expect(await refusal(parse(request({ note: "x".repeat(201) })))).toMatch(/200/);
    // The service says the same if a body ever reached it unvalidated.
    const { service } = build();
    await expect(service.create(ANA_USER, request({ kind: "closure" }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(ANA_USER, request({ kind: "sick_leave" }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a staff account with no professional record cannot ask", async () => {
    const { service, rows } = build();
    await expect(service.create(UNLINKED, request())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.preview(UNLINKED, request())).rejects.toBeInstanceOf(ForbiddenException);
    expect(rows).toHaveLength(0);
  });

  it("answers with the caller's appointments it clashes with, before and after sending", async () => {
    const appointments = [
      { id: "a1", professionalId: ANA, scheduledTime: "10:00", duration: 30 },
      { id: "b1", professionalId: BEA, scheduledTime: "10:00", duration: 30 },
    ];
    const { service, rows } = build({ appointments });
    expect((await service.preview(ANA_USER, request())).conflicts.map((c) => c.id)).toEqual(["a1"]);
    expect(rows).toHaveLength(0);
    expect((await service.create(ANA_USER, request())).conflicts.map((c) => c.id)).toEqual(["a1"]);
  });

  it("tells every active owner and admin of the salon, in Spanish, and nobody else", async () => {
    const { service, notifications } = build({
      appointments: [{ id: "a1", professionalId: ANA, scheduledTime: "10:00", duration: 30 }],
    });
    const out = await service.create(ANA_USER, request());
    const to = notifications.create.mock.calls.map(([dto]: any[]) => dto.userId);
    expect(to.sort()).toEqual([ADMIN.id, OWNER.id].sort());
    expect(notifications.create.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      type: "schedule_change",
      title: "Nueva solicitud de ausencia",
      message: "Ana Gil ha pedido vacaciones del 14/12/2026 al 16/12/2026. Coincide con 1 cita.",
      data: { event: "time_off_requested", timeOffId: out.timeOff.id, link: "/dashboard/solicitudes-ausencia" },
    });
  });

  it("a notification that fails does not lose the request", async () => {
    const { service, rows } = build({ notifyFails: true });
    await expect(service.create(ANA_USER, request())).resolves.toMatchObject({ timeOff: { status: "pending" } });
    expect(rows).toHaveLength(1);
  });
});

describe("a pending request blocks nothing", () => {
  it("is not in the calendar's list for staff, nor for the owner unless asked", async () => {
    const pending = stored({ note: "Boda" });
    const rejected = stored({ status: "rejected", startDate: new Date("2026-12-15T00:00:00.000Z"), endDate: new Date("2026-12-15T00:00:00.000Z") });
    const approved = stored({ status: "approved", professionalId: BEA, requestedById: BEA_USER.id, note: "Viaje" });
    const { timeOff } = build({ timeOff: [pending, rejected, approved] });
    const range = { from: "2026-12-01", to: "2026-12-31" };

    const staff = await timeOff.list(ANA_USER, { ...range, includePending: true });
    expect(staff.map((r: any) => r.id)).toEqual([approved.id]);
    // A colleague's note and the request's details stay out of it.
    expect(staff[0]).not.toHaveProperty("note");
    expect(staff[0]).not.toHaveProperty("decisionNote");

    expect((await timeOff.list(OWNER, range)).map((r: any) => r.id)).toEqual([approved.id]);
    const withPending = await timeOff.list(OWNER, { ...range, includePending: true });
    expect(withPending.map((r: any) => [r.id, r.status]).sort()).toEqual(
      [
        [pending.id, "pending"],
        [approved.id, "approved"],
      ].sort(),
    );
  });
});

describe("my absences", () => {
  // Two weeks before the rows: "recent and ahead" is read from today.
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-01T10:00:00Z")));
  afterEach(() => jest.restoreAllMocks());

  it("lists the caller's own requests and absences, with their notes and the answer", async () => {
    const sick = stored({ kind: "sick_leave", status: "approved", requestedById: null, note: "Gripe" });
    const answered = stored({ status: "rejected", decisionNote: "Temporada alta", note: "Puente" });
    const colleague = stored({ professionalId: BEA, requestedById: BEA_USER.id, note: "Privado" });
    const elsewhere = stored({ tenantId: OTHER });
    const { service } = build({ timeOff: [sick, answered, colleague, elsewhere] });
    const mine = await service.mine(ANA_USER);
    expect(mine.map((r: any) => r.id).sort()).toEqual([sick.id, answered.id].sort());
    // Their own sick leave is theirs to read as it is.
    expect(mine.find((r: any) => r.id === sick.id)).toMatchObject({ kind: "sick_leave", note: "Gripe" });
    expect(mine.find((r: any) => r.id === answered.id)).toMatchObject({
      status: "rejected",
      decisionNote: "Temporada alta",
    });
  });

  it("is empty for an account with no professional", async () => {
    const { service } = build({ timeOff: [stored({})] });
    expect(await service.mine(UNLINKED)).toEqual([]);
  });
});

describe("withdrawing a request", () => {
  it("deletes the caller's own while pending", async () => {
    const mine = stored({});
    const { service, rows } = build({ timeOff: [mine] });
    expect(await service.cancel(ANA_USER, mine.id)).toEqual({ deleted: true });
    expect(rows).toHaveLength(0);
  });

  it("not a colleague's, nor another salon's", async () => {
    const bea = stored({ professionalId: BEA, requestedById: BEA_USER.id });
    const foreign = stored({ tenantId: OTHER });
    const { service, rows } = build({ timeOff: [bea, foreign] });
    await expect(service.cancel(ANA_USER, bea.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.cancel(ANA_USER, foreign.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(2);
  });

  it("not once it has been answered", async () => {
    const approved = stored({ status: "approved" });
    const { service, rows } = build({ timeOff: [approved] });
    await expect(service.cancel(ANA_USER, approved.id)).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toHaveLength(1);
  });
});

describe("the salon's answer", () => {
  it("lists the pending requests of this salon only, and counts them", async () => {
    const pending = stored({});
    const { service } = build({
      timeOff: [
        pending,
        stored({ status: "approved" }),
        stored({ status: "pending", requestedById: null }),
        stored({ tenantId: OTHER }),
      ],
    });
    const list = await service.list(OWNER, {});
    expect(list.map((r: any) => r.id)).toEqual([pending.id]);
    expect(list[0]).toMatchObject({ professionalName: "Ana Gil", status: "pending" });
    expect(await service.pendingCount(OWNER)).toEqual({ count: 1 });
    expect((await service.list(OWNER, { status: "approved" })).length).toBe(1);
  });

  it("approving makes it block, answers with the clashes, and tells the requester", async () => {
    const pending = stored({ endDate: new Date("2026-12-16T00:00:00.000Z") });
    const { service, rows, notifications } = build({
      timeOff: [pending],
      appointments: [{ id: "a1", professionalId: ANA, scheduledTime: "10:00", duration: 30 }],
    });
    const out = await service.approve(OWNER, pending.id, {});
    expect(rows[0]).toMatchObject({ status: "approved", decidedById: OWNER.id });
    expect(rows[0].decidedAt).toBeInstanceOf(Date);
    expect(out.timeOff.status).toBe("approved");
    expect(out.conflicts.map((c) => c.id)).toEqual(["a1"]);
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create.mock.calls[0][0]).toMatchObject({
      userId: ANA_USER.id,
      title: "Ausencia aprobada",
      message: "Tu solicitud de vacaciones del 14/12/2026 al 16/12/2026 ha sido aprobada.",
      data: { event: "time_off_approved", link: "/dashboard/mis-ausencias" },
    });
  });

  it("rejecting keeps it out of the agenda, with the reason for the requester", async () => {
    const pending = stored({ kind: "day_off" });
    const { service, rows, notifications } = build({ timeOff: [pending] });
    const out = await service.reject(ADMIN, pending.id, { note: "Temporada alta" });
    expect(rows[0]).toMatchObject({ status: "rejected", decidedById: ADMIN.id, decisionNote: "Temporada alta" });
    expect(out.timeOff).toMatchObject({ status: "rejected", decisionNote: "Temporada alta" });
    expect(notifications.create.mock.calls[0][0]).toMatchObject({
      userId: ANA_USER.id,
      title: "Ausencia rechazada",
      message: "Tu solicitud de un día libre el 14/12/2026 ha sido rechazada. Motivo: Temporada alta",
      data: { event: "time_off_rejected" },
    });
  });

  it("answers once: a second answer is a 409, and changes nothing", async () => {
    const pending = stored({});
    const { service, rows } = build({ timeOff: [pending] });
    await service.reject(OWNER, pending.id, {});
    await expect(service.approve(ADMIN, pending.id, {})).rejects.toBeInstanceOf(ConflictException);
    expect(rows[0]).toMatchObject({ status: "rejected", decidedById: OWNER.id });
  });

  it("another salon's request is not found", async () => {
    const foreign = stored({ tenantId: OTHER });
    const { service, rows } = build({ timeOff: [foreign] });
    await expect(service.approve(OWNER, foreign.id, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(rows[0].status).toBe("pending");
  });

  it("a decision note is at most 200 characters", async () => {
    const parse = bodyParser(TimeOffController, "reject");
    await expect(parse({ note: "x".repeat(201) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(parse({ note: "  Temporada alta " })).resolves.toEqual({ note: "Temporada alta" });
    await expect(parse({})).resolves.toEqual({});
  });
});

describe("who may call the request routes", () => {
  const roles = (method: keyof TimeOffController) => Reflect.getMetadata(ROLES_KEY, TimeOffController.prototype[method]);

  it("staff ask, see and withdraw their own; owner and admin list and answer", () => {
    for (const method of ["createRequest", "previewRequest", "myRequests", "cancelRequest"] as const) {
      expect(roles(method)).toEqual([UserRole.staff]);
    }
    for (const method of ["listRequests", "pendingCount", "approve", "reject"] as const) {
      expect(roles(method)).toEqual([UserRole.owner, UserRole.admin]);
    }
  });

  it("RolesGuard refuses staff on an answer or the salon's list", () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (handler: (...args: any[]) => unknown, role: string) =>
      ({
        getType: () => "http",
        getHandler: () => handler,
        getClass: () => TimeOffController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role }, method: "POST", url: "/time-off" }) }),
      }) as unknown as ExecutionContext;
    expect(guard.canActivate(ctx(TimeOffController.prototype.approve, "staff"))).toBe(false);
    expect(guard.canActivate(ctx(TimeOffController.prototype.reject, "staff"))).toBe(false);
    expect(guard.canActivate(ctx(TimeOffController.prototype.listRequests, "staff"))).toBe(false);
    expect(guard.canActivate(ctx(TimeOffController.prototype.approve, "admin"))).toBe(true);
    expect(guard.canActivate(ctx(TimeOffController.prototype.createRequest, "staff"))).toBe(true);
    expect(guard.canActivate(ctx(TimeOffController.prototype.createRequest, "client"))).toBe(false);
  });
});
