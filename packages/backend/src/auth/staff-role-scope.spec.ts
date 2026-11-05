import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { ROLES_KEY, SALON_MANAGERS, SALON_TEAM } from "./decorators/roles.decorator";
import { LoyaltyController } from "../loyalty/loyalty.controller";
import { PromotionsController } from "../promotions/promotions.controller";
import { AssistantController } from "../assistant/assistant.controller";
import { PosController } from "../pos/pos.controller";
import { PosService, POS_STAFF_CLIENT_SEARCH_MIN } from "../pos/pos.service";
import { RebookingController } from "../rebooking/rebooking.controller";
import { ConsentService } from "../consent/consent.service";

/**
 * What a professional (role staff) reaches with their session, beyond the
 * screens of their menu (panel audit, staff role).
 *
 * - GET /loyalty/members listed up to 500 clients with email and phone: the
 *   salon's client base in one call. Managers only (the Fidelización screen).
 * - GET /promotions/statistics and GET /assistant/usage are the salon's
 *   marketing and copilot figures: managers only (their screens are).
 * - GET /pos/inventory and /pos/orders(/:id): the stock log and the old
 *   orders (with clients' contact details); no staff screen reads them.
 * - GET /pos/clients: staff find any client at the till, but only with a
 *   search of two characters or more (an empty search returned 50 clients,
 *   one letter walked the whole base). A client who is not theirs comes
 *   back as id, name and a masked phone (D16).
 * - GET /pos/products(/:id) carry the cost price: managers only (D20); the
 *   staff till reads /pos/sale-products.
 * - The rebooking routes of one client took any id: a professional read
 *   any client's cadence and reminders, and could stop them. The client
 *   must now be in reach, as her file; the id must be a UUID.
 */

const roles = (cls: any, name: string) =>
  Reflect.getMetadata(ROLES_KEY, cls.prototype[name]) ?? Reflect.getMetadata(ROLES_KEY, cls);

describe("routes now for managers only", () => {
  it.each([
    [LoyaltyController, "listMembers"],
    [PromotionsController, "getStatistics"],
    [PosController, "getInventoryTransactions"],
    [PosController, "getOrders"],
    [PosController, "getOrderDetails"],
    [PosController, "getProducts"],
    [PosController, "getProduct"],
  ])("%p.%s is owner and admin only", (cls, name) => {
    expect(roles(cls, name)).toEqual(SALON_MANAGERS);
  });

  it("GET /assistant/usage is owner, admin and the platform owner, not staff", () => {
    expect(roles(AssistantController, "getUsage")).toEqual(["owner", "admin", "saas_owner"]);
    // The rest of the copilot stays open to staff (the class roles).
    expect(Reflect.getMetadata(ROLES_KEY, AssistantController)).toContain("staff");
  });

  it.each([
    [LoyaltyController, "enroll"],
    [PromotionsController, "getAll"],
    [PromotionsController, "validateCode"],
    [PosController, "getClients"],
    [PosController, "getProductCategories"],
    [PosController, "saleProducts"],
  ])("%p.%s stays open to the team (the till)", (cls, name) => {
    expect(roles(cls, name)).toEqual(SALON_TEAM);
  });
});

describe("GET /pos/clients for staff", () => {
  const ANA = { id: "u-ana", role: "staff" as const };
  const rows = [
    { id: "c-mine", firstName: "Lucía", lastName: "Mía", email: "lucia@example.test", phone: "+34 600 111 222", status: "active", loyaltyPoints: 30 },
    { id: "c-other", firstName: "Luisa", lastName: "Otra", email: "luisa@example.test", phone: "600 333 444", status: "active", loyaltyPoints: 80 },
  ];
  /** Ana (professional p-ana) has a live appointment with c-mine only. */
  function pos({ professional = { id: "p-ana" } as { id: string } | null } = {}) {
    const findMany = jest.fn(async ({ where }: any) =>
      where.id?.in ? rows.filter((r) => where.id.in.includes(r.id) && r.id === "c-mine").map(({ id }) => ({ id })) : rows,
    );
    const findFirst = jest.fn(async () => professional);
    const service = new PosService({ client: { findMany }, professional: { findFirst } } as any, {} as any);
    return { service, findMany, findFirst };
  }

  it("asks for at least two characters", () => {
    expect(POS_STAFF_CLIENT_SEARCH_MIN).toBe(2);
  });

  it.each([[undefined], [""], ["   "], ["a"], [" 6 "]])("a search of %p is nothing for staff, without asking the database", async (search) => {
    const { service, findMany } = pos();
    expect(await service.getClients("t1", search as any, ANA)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("their own clients come whole; anyone else's as id, name and a masked phone (D16)", async () => {
    const { service } = pos();
    expect(await service.getClients("t1", " lu ", ANA)).toEqual([
      rows[0],
      { id: "c-other", firstName: "Luisa", lastName: "Otra", phone: "···· 444", masked: true },
    ]);
  });

  it("theirs = an appointment with them that is not cancelled, the client file's rule (D17)", async () => {
    const { service, findMany } = pos();
    await service.getClients("t1", "lu", ANA);
    const mine = (findMany.mock.calls[1] as any[])[0].where;
    expect(mine).toEqual({
      tenantId: "t1",
      id: { in: ["c-mine", "c-other"] },
      appointments: { some: { professionalId: "p-ana", status: { not: "cancelled" } } },
    });
  });

  it("searching by email finds only their own clients", async () => {
    const { service, findMany } = pos();
    await service.getClients("t1", "example", ANA);
    const where = (findMany.mock.calls[0] as any[])[0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.OR[0]).toEqual({ firstName: { contains: "example", mode: "insensitive" } });
    expect(where.OR[3]).toEqual({
      email: { contains: "example", mode: "insensitive" },
      appointments: { some: { professionalId: "p-ana", status: { not: "cancelled" } } },
    });
  });

  it("an account with no professional: every row masked, no email search", async () => {
    const { service, findMany } = pos({ professional: null });
    const out = await service.getClients("t1", "lu", ANA);
    expect(out.every((r: any) => r.masked && !("email" in r))).toBe(true);
    expect((findMany.mock.calls[0] as any[])[0].where.OR).toHaveLength(3);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it.each([["owner"], ["admin"]])("%s: unchanged, every row whole, an empty search lists clients", async (role) => {
    const { service, findMany } = pos();
    expect(await service.getClients("t1", undefined, { id: "u-boss", role } as any)).toEqual(rows);
    expect(await service.getClients("t1", "a", { id: "u-boss", role } as any)).toEqual(rows);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("the controller passes who is asking", async () => {
    const getClients = jest.fn(async () => []);
    const controller = new PosController({ getClients } as any, {} as any);
    await controller.getClients({ user: { tenantId: "t1", id: "u-ana", role: "staff" } }, "a");
    expect(getClients).toHaveBeenCalledWith("t1", "a", { id: "u-ana", role: "staff" });
  });
});

describe("rebooking routes of one client", () => {
  const ANA = { tenantId: "t1", id: "u-ana", role: "staff" };
  const OWNER = { tenantId: "t1", id: "u-owner", role: "owner" };

  /** Ana has had an appointment with c-mine; c-other is a client of the salon she never served; c-far is another salon's. */
  function setup() {
    const clients = [
      { id: "c-mine", tenantId: "t1", servedBy: ["u-ana"] },
      { id: "c-other", tenantId: "t1", servedBy: [] as string[] },
      { id: "c-far", tenantId: "t2", servedBy: [] as string[] },
    ];
    const prisma: any = {
      client: {
        findFirst: jest.fn(async ({ where }: any) => {
          const userId = where.appointments?.some?.professional?.userId;
          return (
            clients.find(
              (c) => c.id === where.id && c.tenantId === where.tenantId && (!userId || c.servedBy.includes(userId)),
            ) ?? null
          );
        }),
      },
      clientCadence: { findUnique: jest.fn(async () => ({ clientId: "x" })) },
      rebookingReminder: { findMany: jest.fn(async () => []) },
    };
    const cadence: any = { computeForClient: jest.fn(), optOutClient: jest.fn() };
    const consent = new ConsentService(prisma, {} as any);
    const controller = new RebookingController(cadence, {} as any, prisma, {} as any, consent);
    return { controller, cadence, prisma };
  }

  it("staff reach the clients they have served", async () => {
    const { controller, cadence } = setup();
    await expect(controller.getPrediction({ user: ANA } as any, "c-mine")).resolves.toEqual({ clientId: "x" });
    await expect(controller.getLog({ user: ANA } as any, "c-mine")).resolves.toEqual([]);
    await expect(controller.optOut({ user: ANA } as any, "c-mine")).resolves.toEqual({ ok: true });
    expect(cadence.optOutClient).toHaveBeenCalledWith("c-mine");
  });

  it("not another client of the salon: 404, and nothing computed or stopped", async () => {
    const { controller, cadence, prisma } = setup();
    for (const call of [
      () => controller.getPrediction({ user: ANA } as any, "c-other"),
      () => controller.getLog({ user: ANA } as any, "c-other"),
      () => controller.optOut({ user: ANA } as any, "c-other"),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(cadence.computeForClient).not.toHaveBeenCalled();
    expect(cadence.optOutClient).not.toHaveBeenCalled();
    expect(prisma.rebookingReminder.findMany).not.toHaveBeenCalled();
  });

  it("managers reach every client of their salon, and no other salon's", async () => {
    const { controller, cadence } = setup();
    await expect(controller.getPrediction({ user: OWNER } as any, "c-other")).resolves.toBeDefined();
    await expect(controller.recompute({ user: OWNER } as any, "c-other")).resolves.toEqual({ ok: true });
    await expect(controller.getLog({ user: OWNER } as any, "c-far")).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.optOut({ user: OWNER } as any, "c-far")).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.recompute({ user: OWNER } as any, "c-far")).rejects.toBeInstanceOf(NotFoundException);
    expect(cadence.computeForClient).toHaveBeenCalledTimes(2);
  });

  it.each(["getPrediction", "getLog", "optOut", "recompute"])("%s takes the client id through ParseUUIDPipe", (name) => {
    const params = Reflect.getMetadata("__routeArguments__", RebookingController, name) as Record<string, any>;
    const param = Object.values(params).find((p: any) => typeof p.data === "string");
    expect(param.pipes.map((p: any) => p.name ?? p.constructor?.name)).toContain("ParseUUIDPipe");
  });
});
