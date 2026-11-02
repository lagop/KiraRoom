import { RebookingController } from "./rebooking.controller";
import { ClientCadenceService, TENANT_RECOMPUTE_PAGE } from "./client-cadence.service";
import { UpdateRebookingConfigDto } from "./dto/rebooking.dto";

/**
 * Ajustes > Recordatorios. Saving "días de antelación" or "mínimo de visitas"
 * only merged the JSON: each client's next reminder date was worked out at
 * her next visit, so the change did nothing for weeks (computeForTenant was
 * never called). And the "Últimos recordatorios enviados" card had no data.
 */

const STORED = { enabled: true, leadDays: 3, channelFallback: "email", minVisits: 3 };

function controllerWith(stored: Record<string, unknown> = STORED) {
  const update = jest.fn(async () => ({}));
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({ rebookingSettings: stored, timezone: "Atlantic/Canary" })),
      update,
    },
  };
  const cadence = new ClientCadenceService(prisma);
  const recompute = jest.spyOn(cadence, "recomputeTenantInBackground").mockResolvedValue(undefined);
  const controller = new RebookingController(cadence, {} as any, prisma, {} as any);
  const req = { user: { tenantId: "tenant-1" } } as any;
  const dto = (fields: Record<string, unknown>) => Object.assign(new UpdateRebookingConfigDto(), fields);
  return { controller, req, dto, update, recompute, prisma };
}

describe("PATCH /rebooking/config", () => {
  it.each([
    [{ leadDays: 5 }],
    [{ minVisits: 1 }],
    [{ ...STORED, leadDays: 2 }],
  ])("recomputes the salon's cadences in the background when %p changes them", async (body) => {
    const { controller, req, dto, recompute } = controllerWith();
    const res = await controller.updateConfig(req, dto(body));
    expect(recompute).toHaveBeenCalledWith("tenant-1");
    expect(res.recomputing).toBe(true);
  });

  it("recomputes when reminders are switched back on", async () => {
    const { controller, req, dto, recompute } = controllerWith({ ...STORED, enabled: false });
    await controller.updateConfig(req, dto({ enabled: true }));
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it("does not when only the channel changes, or nothing does", async () => {
    const { controller, req, dto, recompute } = controllerWith();
    await controller.updateConfig(req, dto({ channelFallback: "email" }));
    await controller.updateConfig(req, dto({ ...STORED }));
    await controller.updateConfig(req, dto({ enabled: false }));
    expect(recompute).not.toHaveBeenCalled();
  });

  it.each(["whatsapp", "both"])("saves email when an older panel sends %s", async (channelFallback) => {
    const { controller, req, dto, update } = controllerWith();
    const res = await controller.updateConfig(req, dto({ channelFallback }));
    expect((update.mock.calls[0] as any)[0].data.rebookingSettings.channelFallback).toBe("email");
    expect(res.channelFallback).toBe("email");
  });

  it("a field that was not sent keeps its stored value", async () => {
    const { controller, req, dto, update } = controllerWith();
    await controller.updateConfig(req, dto({ leadDays: 5, minVisits: undefined }));
    expect((update.mock.calls[0] as any)[0].data.rebookingSettings).toEqual({ ...STORED, leadDays: 5 });
  });
});

describe("ClientCadenceService.computeForTenant", () => {
  it("walks the salon's clients with a completed visit in pages, one recompute each", async () => {
    const ids = Array.from({ length: TENANT_RECOMPUTE_PAGE + 3 }, (_, i) => `c${String(i).padStart(4, "0")}`);
    const findMany = jest.fn(async (args: any) => {
      const start = args.cursor ? ids.indexOf(args.cursor.id) + 1 : 0;
      return ids.slice(start, start + args.take).map((id) => ({ id }));
    });
    const svc = new ClientCadenceService({ client: { findMany } } as any);
    const seen: string[] = [];
    jest.spyOn(svc, "computeForClient").mockImplementation(async (id: string) => {
      seen.push(id);
    });
    await expect(svc.computeForTenant("tenant-1")).resolves.toBe(ids.length);
    expect(seen).toEqual(ids);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "tenant-1", appointments: { some: { status: "completed" } } },
      take: TENANT_RECOMPUTE_PAGE,
    });
  });

  it("one client that fails does not stop the others", async () => {
    const svc = new ClientCadenceService({
      client: { findMany: jest.fn(async () => [{ id: "a" }, { id: "b" }]) },
    } as any);
    jest
      .spyOn(svc, "computeForClient")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    await expect(svc.computeForTenant("tenant-1")).resolves.toBe(1);
  });

  it("runs once per salon at a time, and once more for a save made meanwhile", async () => {
    const svc = new ClientCadenceService({} as any);
    let release!: () => void;
    const first = new Promise<number>((resolve) => (release = () => resolve(0)));
    const compute = jest
      .spyOn(svc, "computeForTenant")
      .mockImplementationOnce(() => first)
      .mockResolvedValue(0);
    const running = svc.recomputeTenantInBackground("tenant-1");
    void svc.recomputeTenantInBackground("tenant-1");
    void svc.recomputeTenantInBackground("tenant-1");
    expect(compute).toHaveBeenCalledTimes(1);
    release();
    await running;
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe("GET /rebooking/log", () => {
  it("answers the latest reminders with names, not ids, and the salon's timezone", async () => {
    const { controller, req, prisma } = controllerWith();
    prisma.rebookingReminder = {
      findMany: jest.fn(async () => [
        {
          id: "r1",
          serviceId: "s1",
          scheduledAt: new Date("2026-11-01T09:00:00Z"),
          sentAt: new Date("2026-11-01T09:05:00Z"),
          channel: "email",
          status: "sent",
          createdAt: new Date("2026-11-01T09:00:00Z"),
          client: { firstName: "Ana", lastName: "López" },
        },
        {
          id: "r2",
          serviceId: null,
          scheduledAt: new Date("2026-10-30T09:00:00Z"),
          sentAt: null,
          channel: "email",
          status: "failed",
          createdAt: new Date("2026-10-30T09:00:00Z"),
          client: { firstName: "Eva", lastName: "" },
        },
      ]),
    };
    prisma.service = { findMany: jest.fn(async () => [{ id: "s1", name: "Corte y peinado" }]) };
    const res = await controller.getTenantLog(req, "500");
    expect(prisma.rebookingReminder.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "tenant-1" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    expect(prisma.service.findMany.mock.calls[0][0].where).toEqual({ tenantId: "tenant-1", id: { in: ["s1"] } });
    expect(res.timezone).toBe("Atlantic/Canary");
    expect(res.items.map((i) => [i.clientName, i.serviceName, i.status])).toEqual([
      ["Ana López", "Corte y peinado", "sent"],
      ["Eva", null, "failed"],
    ]);
    expect(JSON.stringify(res)).not.toContain("clientId");
  });
});
