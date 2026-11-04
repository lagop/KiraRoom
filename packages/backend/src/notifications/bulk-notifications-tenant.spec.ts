import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

/** POST /notifications/bulk writes only to the signed-in user's salon and its own clients. */
describe("bulk notifications stay in the salon", () => {
  function service(ownClientIds: string[]) {
    const prisma = {
      client: {
        findMany: jest.fn(async ({ where }: { where: { tenantId: string; id?: { in: string[] } } }) =>
          (where.id ? where.id.in.filter((id) => ownClientIds.includes(id)) : ownClientIds).map((id) => ({ id })),
        ),
      },
      notification: { createMany: jest.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })) },
    };
    return { svc: new NotificationsService(prisma as never, {} as never, {} as never), prisma };
  }

  it("the controller uses the user's tenant, not the body's", async () => {
    const sendBulkToClients = jest.fn().mockResolvedValue({ created: 0 });
    const controller = new NotificationsController({ sendBulkToClients } as never, {} as never);
    await controller.sendBulkToClients({ tenantId: "t1" }, { tenantId: "other", type: "promotion", title: "x", message: "y" } as never);
    expect(sendBulkToClients).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }));
  });

  it("drops client ids that are not the salon's", async () => {
    const { svc, prisma } = service(["c1"]);
    const out = await svc.sendBulkToClients({ tenantId: "t1", type: "promotion", title: "x", message: "y", clientIds: ["c1", "c2"] } as never);
    expect(out.created).toBe(1);
    const rows = prisma.notification.createMany.mock.calls[0][0].data as Array<{ tenantId: string; clientId: string }>;
    expect(rows).toEqual([expect.objectContaining({ tenantId: "t1", clientId: "c1" })]);
  });
});
