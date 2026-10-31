import { randomUUID } from "crypto";
import { BadRequestException, ExecutionContext, NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { TimeOffService, TimeOffUser } from "./time-off.service";
import { TimeOffController } from "./time-off.controller";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { bodyParser } from "../common/validation/validated-body.testing";

/**
 * /time-off: recording time off and closures, and the appointments they
 * clash with.
 *
 * Nothing already booked is cancelled when a block is recorded: the preview
 * (and the answer to the write) lists the visits that fall inside it, so the
 * salon moves them or warns the client. The list counts each service of a
 * multi-service visit on its own professional, and leaves out what no longer
 * holds its time (cancelled, completed, no-show).
 */

const TENANT = "tenant-a";
const OTHER = "tenant-b";
// Built at runtime: ids are UUIDs to the DTOs, and literals next to id keys
// read as secrets to the scanner.
const ANA = randomUUID();
const BEA = randomUUID();
const FOREIGN_PRO = randomUUID();
const DAY = "2026-12-14";

const OWNER: TimeOffUser = { id: "u-owner", tenantId: TENANT, role: "owner" };
const STAFF: TimeOffUser = { id: "u-staff", tenantId: TENANT, role: "staff" };

interface Apt {
  id: string;
  tenantId?: string;
  professionalId: string;
  day?: string;
  scheduledTime: string;
  duration: number;
  status?: string;
  services?: any[];
}

function build(opts: { appointments?: Apt[]; timeOff?: any[] } = {}) {
  const people: Record<string, { id: string; firstName: string; lastName: string; tenantId: string }> = {
    [ANA]: { id: ANA, firstName: "Ana", lastName: "Gil", tenantId: TENANT },
    [BEA]: { id: BEA, firstName: "Bea", lastName: "Ruiz", tenantId: TENANT },
    [FOREIGN_PRO]: { id: FOREIGN_PRO, firstName: "Zoe", lastName: "X", tenantId: OTHER },
  };
  const appointments = (opts.appointments ?? []).map((a) => ({
    tenantId: TENANT,
    status: "confirmed",
    services: [],
    ...a,
    scheduledDate: new Date(`${a.day ?? DAY}T00:00:00.000Z`),
    client: { firstName: "Lucía", lastName: "Pérez" },
    service: { name: "Corte" },
    professional: people[a.professionalId],
  }));
  const rows = [...(opts.timeOff ?? [])];
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => ({ timezone: "Europe/Madrid" })) },
    professional: {
      findFirst: jest.fn(async ({ where }: any) => {
        const p = people[where.id];
        return p && p.tenantId === where.tenantId ? { id: p.id } : null;
      }),
    },
    // Answers the query the way the database would.
    appointment: {
      findMany: jest.fn(async ({ where }: any) =>
        appointments.filter((a) => {
          if (a.tenantId !== where.tenantId) return false;
          if (!where.status.in.includes(a.status)) return false;
          if (a.scheduledDate < where.scheduledDate.gte || a.scheduledDate > where.scheduledDate.lte) return false;
          if (!where.OR) return true;
          const pro = where.OR[0].professionalId;
          return a.professionalId === pro || a.services.some((s: any) => s.professionalId === pro);
        }),
      ),
    },
    timeOff: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter(
          (r) =>
            r.tenantId === where.tenantId &&
            r.startDate <= where.startDate.lte &&
            r.endDate >= where.endDate.gte &&
            (!where.professionalId || r.professionalId === where.professionalId) &&
            (typeof where.status === "string"
              ? (r.status ?? "approved") === where.status
              : where.status.in.includes(r.status ?? "approved")),
        ),
      ),
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: randomUUID(), ...data, professional: data.professionalId ? people[data.professionalId] : null };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id && r.tenantId === where.tenantId);
        Object.assign(row, data);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const i = rows.findIndex((r) => r.id === where.id && r.tenantId === where.tenantId);
        if (i === -1) return { count: 0 };
        rows.splice(i, 1);
        return { count: 1 };
      }),
    },
  };
  return { service: new TimeOffService(prisma), prisma, rows };
}

const stored = (r: Record<string, unknown>) => ({
  id: randomUUID(),
  tenantId: TENANT,
  professionalId: ANA,
  kind: "vacation",
  startDate: new Date(`${DAY}T00:00:00.000Z`),
  endDate: new Date(`${DAY}T00:00:00.000Z`),
  startTime: null,
  endTime: null,
  note: null,
  professional: { firstName: "Ana", lastName: "Gil" },
  ...r,
});

/** A colour by Bea, then a rinse by Ana: 10:00–11:00 and 11:00–11:30. */
const colourThenRinse = (status = "confirmed"): Apt => ({
  id: "visit",
  professionalId: BEA,
  scheduledTime: "10:00",
  duration: 90,
  status,
  services: [
    { id: "r1", professionalId: BEA, scheduledStart: null, scheduledEnd: null, isParallel: false, status: "active", service: { duration: 60, name: "Color" }, professional: { id: BEA, firstName: "Bea", lastName: "Ruiz" } },
    { id: "r2", professionalId: ANA, scheduledStart: null, scheduledEnd: null, isParallel: false, status: "active", service: { duration: 30, name: "Aclarado" }, professional: { id: ANA, firstName: "Ana", lastName: "Gil" } },
  ],
});

describe("conflict preview", () => {
  const block = (b: Record<string, unknown>) =>
    ({ professionalId: ANA, kind: "vacation", startDate: DAY, endDate: DAY, ...b }) as any;

  it("lists a professional's appointments inside an all-day block, with what the salon needs", async () => {
    const { service } = build({
      appointments: [
        { id: "a1", professionalId: ANA, scheduledTime: "10:00", duration: 30 },
        { id: "a2", professionalId: BEA, scheduledTime: "10:00", duration: 30 },
      ],
    });
    expect((await service.preview(OWNER, block({}))).conflicts).toEqual([
      {
        id: "a1",
        date: DAY,
        time: "10:00",
        clientName: "Lucía Pérez",
        serviceNames: ["Corte"],
        professionalName: "Ana Gil",
        status: "confirmed",
      },
    ]);
  });

  it("counts a multi-service visit by each service's own professional", async () => {
    const { service } = build({ appointments: [colourThenRinse()] });
    // Ana's rinse is at 11:00: her hour off at 11:00 catches the visit...
    const caught = (await service.preview(OWNER, block({ kind: "other", startTime: "11:00", endTime: "12:00" }))).conflicts;
    expect(caught).toHaveLength(1);
    expect(caught[0]).toMatchObject({ id: "visit", professionalName: "Ana Gil", serviceNames: ["Color", "Aclarado"] });
    // ...her hour off at 10:00 does not: Bea does the colour then.
    expect((await service.preview(OWNER, block({ kind: "other", startTime: "10:00", endTime: "11:00" }))).conflicts).toEqual([]);
  });

  it("a closure catches everyone's appointments, and names who is caught", async () => {
    const { service } = build({
      appointments: [colourThenRinse(), { id: "a3", professionalId: ANA, scheduledTime: "17:00", duration: 30 }],
    });
    const morning = await service.preview(OWNER, block({ professionalId: null, kind: "closure", startTime: "09:00", endTime: "14:00" }));
    expect(morning.conflicts.map((c) => [c.id, c.professionalName])).toEqual([["visit", "Bea Ruiz, Ana Gil"]]);
  });

  it("leaves out cancelled, completed and no-show appointments, and days outside the block", async () => {
    const { service, prisma } = build({
      appointments: [
        { id: "cancelled", professionalId: ANA, scheduledTime: "10:00", duration: 30, status: "cancelled" },
        { id: "done", professionalId: ANA, scheduledTime: "11:00", duration: 30, status: "completed" },
        { id: "missed", professionalId: ANA, scheduledTime: "12:00", duration: 30, status: "no_show" },
        { id: "pending", professionalId: ANA, scheduledTime: "13:00", duration: 30, status: "pending" },
        { id: "next-day", professionalId: ANA, day: "2026-12-15", scheduledTime: "10:00", duration: 30 },
      ],
    });
    const { conflicts } = await service.preview(OWNER, block({}));
    expect(conflicts.map((c) => c.id)).toEqual(["pending"]);
    expect(prisma.appointment.findMany.mock.calls[0][0].where.status).toEqual({ in: ["pending", "confirmed", "in_progress"] });
  });

  it("only reads this salon's appointments", async () => {
    const { service, prisma } = build({
      appointments: [{ id: "elsewhere", tenantId: OTHER, professionalId: ANA, scheduledTime: "10:00", duration: 30 }],
    });
    expect((await service.preview(OWNER, block({}))).conflicts).toEqual([]);
    expect(prisma.appointment.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT);
  });

  it("refuses another salon's professional", async () => {
    const { service } = build();
    await expect(service.preview(OWNER, block({ professionalId: FOREIGN_PRO }))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("create, update and delete", () => {
  it("stores the block for the caller's salon and answers with its clashes", async () => {
    const { service, rows } = build({ appointments: [{ id: "a1", professionalId: ANA, scheduledTime: "10:00", duration: 30 }] });
    const out = await service.create(OWNER, { professionalId: ANA, kind: "vacation", startDate: DAY, endDate: "2026-12-20", note: "Viaje" });
    expect(rows[0]).toMatchObject({ tenantId: TENANT, professionalId: ANA, createdById: "u-owner", startTime: null });
    expect(out.timeOff).toMatchObject({ professionalId: ANA, professionalName: "Ana Gil", startDate: DAY, endDate: "2026-12-20", note: "Viaje" });
    expect(out.conflicts.map((c) => c.id)).toEqual(["a1"]);
  });

  it("an edit keeps what it leaves out, clears the hours with null, and checks the result", async () => {
    const row = stored({ startTime: "10:00", endTime: "12:00", kind: "other", note: "Médico" });
    const { service } = build({ timeOff: [row] });
    const edited = await service.update(OWNER, row.id, { endTime: "13:00" });
    expect(edited.timeOff).toMatchObject({ startTime: "10:00", endTime: "13:00", note: "Médico" });

    await expect(service.update(OWNER, row.id, { endDate: "2026-12-16" })).rejects.toThrow(/un único día/);
    const allDay = await service.update(OWNER, row.id, { startTime: null, endTime: null, endDate: "2026-12-16" });
    expect(allDay.timeOff).toMatchObject({ startTime: null, endTime: null, endDate: "2026-12-16" });
  });

  it("another salon's block cannot be changed or deleted", async () => {
    const foreign = stored({ tenantId: OTHER });
    const { service, rows } = build({ timeOff: [foreign] });
    await expect(service.update(OWNER, foreign.id, { note: "x" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(OWNER, foreign.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(1);
  });

  it("deletes the salon's own", async () => {
    const mine = stored({});
    const { service, rows } = build({ timeOff: [mine] });
    expect(await service.remove(OWNER, mine.id)).toEqual({ deleted: true });
    expect(rows).toHaveLength(0);
  });
});

describe("listing", () => {
  const rows = () => [
    stored({ note: "Operación" , kind: "sick_leave" }),
    stored({ professionalId: null, kind: "closure", note: "Navidad", professional: null }),
    stored({ tenantId: OTHER, professionalId: FOREIGN_PRO, note: "otro salón" }),
  ];

  it("gives the owner everything of the salon, and nothing of another", async () => {
    const { service } = build({ timeOff: rows() });
    const list = await service.list(OWNER, { from: "2026-12-01", to: "2026-12-31" });
    expect(list.map((r: any) => [r.kind, r.note])).toEqual([
      ["sick_leave", "Operación"],
      ["closure", "Navidad"],
    ]);
  });

  it("hides a colleague's note and sick leave from staff, but not the salon's closure note", async () => {
    const { service } = build({ timeOff: rows() });
    const list = await service.list(STAFF, { from: "2026-12-01", to: "2026-12-31" });
    expect(list[0]).not.toHaveProperty("note");
    expect(list[0]).toMatchObject({ kind: "other", professionalName: "Ana Gil" });
    expect(list[1]).toMatchObject({ kind: "closure", note: "Navidad" });
    const owner = await service.list(OWNER, { from: "2026-12-01", to: "2026-12-31" });
    expect(owner[0]).toMatchObject({ kind: "sick_leave", note: "Operación" });
  });

  it("refuses a range backwards or longer than 400 days", async () => {
    const { service } = build();
    await expect(service.list(OWNER, { from: "2026-12-31", to: "2026-12-01" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(OWNER, { from: "2026-01-01", to: "2027-02-05" })).rejects.toThrow(/400/);
    await expect(service.list(OWNER, { from: "2026-01-01", to: "2027-02-04" })).resolves.toEqual([]);
  });
});

describe("request bodies (the global ValidationPipe)", () => {
  const create = bodyParser(TimeOffController, "create");
  const preview = bodyParser(TimeOffController, "preview");
  const update = bodyParser(TimeOffController, "update");
  const refusal = (p: Promise<any>) =>
    p.then(
      () => null,
      (e) => {
        expect(e).toBeInstanceOf(BadRequestException);
        return ([] as string[]).concat((e.getResponse() as any).message).join(" | ");
      },
    );
  const ok = { professionalId: ANA, kind: "vacation", startDate: "2026-12-01", endDate: "2026-12-05" };

  it("accepts all day, hours on one day, and a closure", async () => {
    expect(await refusal(create(ok))).toBeNull();
    expect(await refusal(create({ ...ok, endDate: ok.startDate, startTime: "10:00", endTime: "12:30" }))).toBeNull();
    expect(await refusal(create({ kind: "closure", startDate: "2026-12-25", endDate: "2026-12-25", note: "Navidad" }))).toBeNull();
  });

  it("refuses hours over several days, and an end before the start", async () => {
    expect(await refusal(create({ ...ok, startTime: "10:00", endTime: "12:00" }))).toMatch(/un único día/);
    expect(await refusal(create({ ...ok, endDate: "2026-11-30" }))).toMatch(/anterior/);
    expect(await refusal(preview({ ...ok, endDate: ok.startDate, startTime: "12:00", endTime: "11:00" }))).toMatch(/posterior/);
  });

  it("refuses a block longer than 366 days", async () => {
    expect(await refusal(create({ ...ok, startDate: "2026-01-01", endDate: "2027-01-02" }))).toMatch(/366/);
  });

  it("refuses malformed values", async () => {
    expect(await refusal(create({ ...ok, startDate: "01/12/2026" }))).toMatch(/AAAA-MM-DD/);
    expect(await refusal(create({ ...ok, endDate: ok.startDate, startTime: "9:00", endTime: "10:00" }))).toMatch(/HH:MM/);
    expect(await refusal(create({ ...ok, kind: "holiday" }))).toMatch(/tipo/);
    expect(await refusal(create({ ...ok, professionalId: "ana" }))).toMatch(/profesional/);
    expect(await refusal(create({ ...ok, note: "x".repeat(201) }))).toMatch(/200/);
  });

  it("reads an emptied time as all day, and drops what it does not know", async () => {
    const body = await create({ ...ok, startTime: "", endTime: "", tenantId: OTHER, createdById: "someone" });
    expect(body).toMatchObject({ startTime: null, endTime: null });
    expect(body).not.toHaveProperty("tenantId");
    expect(body).not.toHaveProperty("createdById");
  });

  it("an edit cannot move the block to another professional", async () => {
    const body = await update({ professionalId: BEA, note: "x" });
    expect(body).not.toHaveProperty("professionalId");
  });
});

describe("who may call what", () => {
  const roles = (method: keyof TimeOffController) => Reflect.getMetadata(ROLES_KEY, TimeOffController.prototype[method]);

  it("the whole team reads; only owner and admin write", () => {
    expect(roles("list")).toEqual([UserRole.owner, UserRole.admin, UserRole.staff]);
    for (const method of ["preview", "create", "update", "remove"] as const) {
      expect(roles(method)).toEqual([UserRole.owner, UserRole.admin]);
    }
  });

  it("RolesGuard refuses staff on a write and lets them read", () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (handler: (...args: any[]) => unknown, role: string) =>
      ({
        getType: () => "http",
        getHandler: () => handler,
        getClass: () => TimeOffController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role }, method: "POST", url: "/time-off" }) }),
      }) as unknown as ExecutionContext;
    expect(guard.canActivate(ctx(TimeOffController.prototype.create, "staff"))).toBe(false);
    expect(guard.canActivate(ctx(TimeOffController.prototype.remove, "staff"))).toBe(false);
    expect(guard.canActivate(ctx(TimeOffController.prototype.create, "admin"))).toBe(true);
    expect(guard.canActivate(ctx(TimeOffController.prototype.list, "staff"))).toBe(true);
    expect(guard.canActivate(ctx(TimeOffController.prototype.list, "client"))).toBe(false);
  });
});
