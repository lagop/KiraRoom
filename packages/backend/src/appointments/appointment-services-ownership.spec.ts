import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { AppointmentServicesService } from "./appointment-services.service";

/**
 * /appointment-services: who sees and acts on which service rows.
 *
 * Only the timing routes (move, timing, mode, reorder) checked the caller.
 * The rest -- list, read, create, start, complete, cancel, delete, the
 * processing block -- let a professional reach any row of the salon,
 * colleagues' included. A professional (role staff) now sees and acts on
 * their own rows only: the services they perform, and a row nobody performs
 * (a colour's processing time) of an appointment that is theirs. Owners and
 * managers, the whole salon; nobody, another salon.
 */

// The visit totals are not what this spec is about.
jest.mock("./visit-sync", () => ({ syncVisitTotals: jest.fn(async () => undefined) }));

const TENANT = "t1";
const ANA_USER = { id: "u-ana", role: "staff", tenantId: TENANT };
const UNLINKED = { id: "u-nobody", role: "staff", tenantId: TENANT };
const OWNER = { id: "u-owner", role: "owner", tenantId: TENANT };

/** Ana's visit, with one of Bea's services in it; Bea's visit, with one of Ana's. */
const APPOINTMENTS = [
  { id: "apt-ana", tenantId: TENANT, professionalId: "ana", status: "confirmed" },
  { id: "apt-bea", tenantId: TENANT, professionalId: "bea", status: "confirmed" },
  { id: "apt-other-salon", tenantId: "t2", professionalId: "zoe", status: "confirmed" },
];
const PROFESSIONALS = [
  { id: "ana", userId: "u-ana", tenantId: TENANT },
  { id: "bea", userId: "u-bea", tenantId: TENANT },
  { id: "zoe", userId: "u-zoe", tenantId: "t2" },
];

function rows() {
  const row = (id: string, appointmentId: string, professionalId: string | null, extra: object = {}) => ({
    id,
    appointmentId,
    professionalId,
    serviceId: "svc-colour",
    status: "pending",
    scheduledStart: new Date("2026-11-02T09:00:00.000Z"),
    scheduledEnd: new Date("2026-11-02T10:00:00.000Z"),
    ...extra,
  });
  return [
    row("ana-own", "apt-ana", "ana"),
    row("ana-processing", "apt-ana", null, { type: "processing" }),
    row("bea-in-ana", "apt-ana", "bea"),
    row("bea-own", "apt-bea", "bea"),
    row("ana-in-bea", "apt-bea", "ana"),
    row("other-salon", "apt-other-salon", "zoe"),
  ];
}

/** Enough of Prisma's where for these queries: equality, `in`, OR, and the appointment relation. */
function matches(record: any, where: any): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === "OR") {
      if (!(value as any[]).some((w) => matches(record, w))) return false;
    } else if (key === "appointment") {
      const apt = APPOINTMENTS.find((a) => a.id === record.appointmentId);
      if (!apt || !matches(apt, value)) return false;
    } else if (key === "service") {
      continue;
    } else if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("in" in (value as any) && !(value as any).in.includes(record[key])) return false;
      if ("notIn" in (value as any) && (value as any).notIn.includes(record[key])) return false;
    } else if (record[key] !== value) {
      return false;
    }
  }
  return true;
}

/** A row as read with its appointment. */
const withVisit = (r: any) => ({
  ...r,
  appointment: { ...APPOINTMENTS.find((a) => a.id === r.appointmentId), tenant: { timezone: "Europe/Madrid" } },
});

function build() {
  const table = rows();
  const writes: Array<[string, any]> = [];
  const prisma: any = {
    appointment: {
      findFirst: jest.fn(async ({ where }: any) => APPOINTMENTS.find((a) => matches(a, where)) ?? null),
    },
    professional: {
      findFirst: jest.fn(async ({ where }: any) => PROFESSIONALS.find((p) => matches(p, where)) ?? null),
      count: jest.fn(async ({ where }: any) => PROFESSIONALS.filter((p) => matches(p, where)).length),
    },
    service: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === TENANT ? { id: where.id, hasProcessingTime: true, processingDuration: 20, duration: 60 } : null,
      ),
      count: jest.fn(async ({ where }: any) => (where.tenantId === TENANT ? where.id.in.length : 0)),
    },
    appointmentService: {
      findMany: jest.fn(async ({ where }: any) => table.filter((r) => matches(r, where)).map(withVisit)),
      findFirst: jest.fn(async ({ where }: any) => {
        const r = table.find((x) => matches(x, where));
        return r ? withVisit(r) : null;
      }),
      count: jest.fn(async ({ where }: any) => table.filter((r) => matches(r, where)).length),
      create: jest.fn(async (args: any) => {
        writes.push(["create", args]);
        return { id: "new-row", ...args.data };
      }),
      update: jest.fn(async (args: any) => {
        writes.push(["update", args]);
        const r = table.find((x) => matches(x, args.where));
        if (!r) throw new Error("Record to update not found.");
        return { ...r, ...args.data };
      }),
      delete: jest.fn(async (args: any) => {
        writes.push(["delete", args]);
        return {};
      }),
    },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  return { svc: new AppointmentServicesService(prisma), prisma, writes };
}

const ids = (list: any[]) => list.map((r) => r.id).sort();

describe("a professional reads their own service rows only", () => {
  it("the list: the services they do, and the processing time of their own visit", async () => {
    const { svc } = build();
    expect(ids(await svc.findAll({} as any, ANA_USER))).toEqual(["ana-in-bea", "ana-own", "ana-processing"]);
  });

  it("asking for a colleague's professionalId changes nothing", async () => {
    const { svc } = build();
    expect(await svc.findAll({ professionalId: "bea" } as any, ANA_USER)).toEqual([]);
  });

  it("a visit: only their rows of it", async () => {
    const { svc } = build();
    expect(ids(await svc.findByAppointment("apt-bea", ANA_USER))).toEqual(["ana-in-bea"]);
    expect(ids(await svc.findByAppointment("apt-ana", ANA_USER))).toEqual(["ana-own", "ana-processing"]);
    expect(ids(await svc.getServicesWithProcessingTime("apt-bea", ANA_USER))).toEqual(["ana-in-bea"]);
  });

  it("one row: theirs, yes; a colleague's, not found", async () => {
    const { svc } = build();
    await expect(svc.findOne("ana-in-bea", ANA_USER)).resolves.toMatchObject({ id: "ana-in-bea" });
    await expect(svc.findOne("bea-in-ana", ANA_USER)).rejects.toThrow(NotFoundException);
    await expect(svc.findOne("bea-own", ANA_USER)).rejects.toThrow(NotFoundException);
  });

  it("a staff account linked to no professional sees nothing", async () => {
    const { svc } = build();
    expect(await svc.findAll({} as any, UNLINKED)).toEqual([]);
    expect(await svc.findByAppointment("apt-ana", UNLINKED)).toEqual([]);
    await expect(svc.findOne("ana-own", UNLINKED)).rejects.toThrow(NotFoundException);
  });

  it("the owner sees the whole salon, and nothing of another", async () => {
    const { svc } = build();
    expect(ids(await svc.findAll({} as any, OWNER))).toEqual([
      "ana-in-bea",
      "ana-own",
      "ana-processing",
      "bea-in-ana",
      "bea-own",
    ]);
    await expect(svc.findOne("other-salon", OWNER)).rejects.toThrow(NotFoundException);
  });
});

describe("a professional acts on their own service rows only", () => {
  const actions: Array<[string, (svc: AppointmentServicesService, id: string) => Promise<unknown>]> = [
    ["start", (svc, id) => svc.startService(id, ANA_USER)],
    ["complete", (svc, id) => svc.completeService(id, ANA_USER)],
    ["cancel", (svc, id) => svc.cancelService(id, ANA_USER)],
    ["delete", (svc, id) => svc.remove(id, ANA_USER)],
    ["processing block", (svc, id) => svc.createProcessingBlocks(id, ANA_USER)],
    ["edit", (svc, id) => svc.update(id, { notes: "x" } as any, ANA_USER)],
  ];

  it.each(actions)("%s: refused on a colleague's row, even in their own visit; nothing written", async (_name, act) => {
    for (const id of ["bea-in-ana", "bea-own"]) {
      const { svc, writes } = build();
      await expect(act(svc, id)).rejects.toThrow(NotFoundException);
      expect(writes).toEqual([]);
    }
  });

  it.each(actions)("%s: allowed on their own row, in a colleague's visit too", async (_name, act) => {
    const { svc, writes } = build();
    await act(svc, "ana-in-bea");
    expect(writes.length).toBeGreaterThan(0);
    // Every write names the salon as well as the row.
    for (const [, args] of writes.filter(([kind]) => kind !== "create")) {
      expect(args.where).toMatchObject({ appointment: { tenantId: TENANT } });
    }
  });

  it("the owner acts on anyone's row", async () => {
    const { svc, writes } = build();
    await svc.completeService("bea-own", OWNER);
    expect(writes).toHaveLength(1);
  });
});

describe("a professional adds services only to their own visit, and only their own", () => {
  const dto = (over: object = {}) => ({ appointmentId: "apt-ana", serviceId: "svc-colour", ...over }) as any;

  it("to a colleague's visit: not found", async () => {
    const { svc, writes } = build();
    await expect(svc.create(dto({ appointmentId: "apt-bea", professionalId: "ana" }), ANA_USER)).rejects.toThrow(
      NotFoundException,
    );
    await expect(svc.bulkCreate("apt-bea", [dto({ professionalId: "ana" })], ANA_USER)).rejects.toThrow(
      NotFoundException,
    );
    expect(writes).toEqual([]);
  });

  it("a colleague's service into their own visit: refused", async () => {
    const { svc, writes } = build();
    await expect(svc.create(dto({ professionalId: "bea" }), ANA_USER)).rejects.toThrow(ForbiddenException);
    await expect(
      svc.bulkCreate("apt-ana", [dto({ professionalId: "ana" }), dto({ professionalId: "bea" })], ANA_USER),
    ).rejects.toThrow(ForbiddenException);
    expect(writes).toEqual([]);
  });

  it("their own service into their own visit: added", async () => {
    const { svc, writes } = build();
    await svc.create(dto({ professionalId: "ana" }), ANA_USER);
    await svc.create(dto(), ANA_USER);
    await svc.bulkCreate("apt-ana", [dto({ professionalId: "ana" })], ANA_USER);
    expect(writes.filter(([kind]) => kind === "create")).toHaveLength(3);
  });

  it("the owner adds anyone's service to any visit of the salon, and to none of another", async () => {
    const { svc } = build();
    await expect(svc.create(dto({ appointmentId: "apt-bea", professionalId: "ana" }), OWNER)).resolves.toBeDefined();
    await expect(svc.create(dto({ appointmentId: "apt-other-salon" }), OWNER)).rejects.toThrow(NotFoundException);
  });
});
