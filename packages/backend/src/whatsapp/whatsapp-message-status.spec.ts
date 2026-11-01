import { WhatsAppService } from "./whatsapp.service";

/**
 * Meta's delivery statuses for campaign messages (M10). They do not arrive in
 * order: a late "delivered" used to turn a "read" back into "delivered". A
 * status now only moves forward, "failed" is terminal, and an account-level
 * failure (payment...) pauses the campaign instead of failing the client.
 */
function service(recipient: any) {
  const prisma: any = {
    whatsAppCampaignRecipient: {
      findFirst: jest.fn(async () => recipient),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => ({})),
    },
    whatsAppCampaign: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const s = new WhatsAppService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
  (s as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { s, prisma };
}

const recipient = { id: "r1", campaignId: "camp1", campaign: { status: "sending" } };
const change = (status: Record<string, unknown>) => ({ value: { statuses: [{ id: "wamid.1", ...status }] } });

describe("WhatsApp webhook: campaign message statuses never go back", () => {
  it("'read' only moves forward from pending, sent or delivered, with Meta's time", async () => {
    const { s, prisma } = service(recipient);
    await (s as any).handleChange("t1", change({ status: "read", timestamp: "1791100000" }));
    expect(prisma.whatsAppCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", status: { in: ["pending", "sent", "delivered"] } },
      data: { status: "read", readAt: new Date(1791100000 * 1000) },
    });
  });

  it("a late 'delivered' cannot overwrite 'read' (only pending/sent are matched)", async () => {
    const { s, prisma } = service(recipient);
    await (s as any).handleChange("t1", change({ status: "delivered" }));
    expect(prisma.whatsAppCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", status: { in: ["pending", "sent"] } },
      data: { status: "delivered", deliveredAt: expect.any(Date) },
    });
  });

  it("a late 'sent' only touches a message still pending", async () => {
    const { s, prisma } = service(recipient);
    await (s as any).handleChange("t1", change({ status: "sent" }));
    expect(prisma.whatsAppCampaignRecipient.updateMany.mock.calls[0][0].where).toEqual({
      id: "r1",
      status: { in: ["pending"] },
    });
  });

  it("'failed' is taken only before the message is known to have arrived", async () => {
    const { s, prisma } = service(recipient);
    await (s as any).handleChange("t1", change({ status: "failed", errors: [{ code: 131026, title: "Undeliverable" }] }));
    expect(prisma.whatsAppCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", status: { in: ["pending", "sent"] } },
      data: { status: "failed", externalError: expect.stringContaining("131026") },
    });
    expect(prisma.whatsAppCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("an unknown status changes nothing", async () => {
    const { s, prisma } = service(recipient);
    await (s as any).handleChange("t1", change({ status: "deleted" }));
    expect(prisma.whatsAppCampaignRecipient.updateMany).not.toHaveBeenCalled();
  });

  it("a payment failure pauses the campaign and puts the message back to pending", async () => {
    const { s, prisma } = service(recipient);
    await (s as any).handleChange("t1", change({ status: "failed", errors: [{ code: 131042 }] }));
    expect(prisma.whatsAppCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", status: "sent" },
      data: { status: "pending", externalError: "meta_131042" },
    });
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: "camp1", status: "sending" },
      data: { status: "paused", lastError: expect.stringContaining("método de pago") },
    });
  });

  it("once the campaign has finished, an account-level failure is just a failure", async () => {
    const { s, prisma } = service({ ...recipient, campaign: { status: "completed" } });
    await (s as any).handleChange("t1", change({ status: "failed", errors: [{ code: 131042 }] }));
    expect(prisma.whatsAppCampaign.updateMany).not.toHaveBeenCalled();
    expect(prisma.whatsAppCampaignRecipient.updateMany.mock.calls[0][0].data.status).toBe("failed");
  });

  it("a status for a message that is not a campaign's is ignored", async () => {
    const { s, prisma } = service(null);
    await (s as any).handleChange("t1", change({ status: "read" }));
    expect(prisma.whatsAppCampaignRecipient.updateMany).not.toHaveBeenCalled();
  });
});
