import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

/**
 * GET /payments/client/:clientId passed (clientId, tenantId) to a service
 * that takes (tenantId, clientId): it looked for the client's id as the
 * salon, so a client's payment history was always empty (or refused by the
 * tenant scope).
 */
describe("GET /payments/client/:clientId", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const CLIENT = "22222222-2222-4222-8222-222222222222";

  it("asks the service for this salon's payments of that client", async () => {
    const prisma: any = { payment: { findMany: jest.fn(async () => [{ id: "pay1" }]) } };
    const service = new PaymentsService(prisma);
    const controller = new PaymentsController(service, {} as any, {} as any, {} as any, {} as any, {} as any);

    const out = await controller.getPaymentsByClient({ user: { tenantId: TENANT, role: "owner" } }, CLIENT);

    expect(out).toEqual([{ id: "pay1" }]);
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, clientId: CLIENT } }),
    );
  });
});
