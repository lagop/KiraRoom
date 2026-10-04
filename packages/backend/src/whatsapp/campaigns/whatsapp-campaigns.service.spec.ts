import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { WhatsAppCampaignsService } from "./whatsapp-campaigns.service";

/**
 * WhatsApp campaigns. Before: the endpoint marked recipients "pending" and
 * the campaign "sending", and nothing ever sent them; it used any template,
 * ignored consent, and sent or reported any salon's campaign by id. These
 * pin the flow that replaced it: Meta reviews the text, only clients who
 * opted in get it, sending goes in batches and stops on Meta's limits.
 */

const ID = "3f2a9c1e-77b1-4c2d-9e10-aa55cc66dd77";
/** 12:00 in Madrid: inside the sending hours. */
const NOON = new Date("2026-10-10T10:00:00Z");

function campaignRow(over: Record<string, any> = {}) {
  return {
    id: ID,
    tenantId: "t1",
    name: "Otoño",
    body: "Hola {{nombre}}, 20 % en mechas este mes.",
    templateId: "",
    templateStatus: "draft",
    status: "draft",
    scheduledAt: null,
    segmentFilter: {},
    ...over,
  };
}

/** Accepted WhatsApp promotions: consent rows as clientsWhoAcceptedWhatsAppMarketing reads them. */
function consentRows(accepted: string[]) {
  return jest.fn(async ({ where }: any) =>
    accepted
      .filter((id) => !where.clientId || where.clientId.in.includes(id))
      .map((clientId) => ({ clientId, responses: { accepts: true } })),
  );
}

function setup(opts: { campaign?: any; accepted?: string[]; templates?: any } = {}) {
  const prisma: any = {
    whatsAppCampaign: {
      findFirst: jest.fn(async ({ where }: any) =>
        opts.campaign && where.id === opts.campaign.id && where.tenantId === opts.campaign.tenantId ? opts.campaign : null,
      ),
      findMany: jest.fn(async () => (opts.campaign ? [opts.campaign] : [])),
      create: jest.fn(async ({ data }: any) => ({ id: ID, ...data })),
      update: jest.fn(async ({ data }: any) => ({ ...opts.campaign, ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      delete: jest.fn(async () => ({})),
    },
    whatsAppCampaignRecipient: {
      findMany: jest.fn(async () => []),
      createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
      update: jest.fn(async () => ({})),
      groupBy: jest.fn(async () => []),
    },
    client: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    consent: { findMany: consentRows(opts.accepted ?? []) },
  };
  const templates: any = {
    createTemplate: jest.fn(async () => ({ status: "PENDING" })),
    templateReview: jest.fn(async () => ({ status: "PENDING" })),
    sendApprovedTemplate: jest.fn(async () => ({ sent: true, messageId: "wamid.1" })),
    ...opts.templates,
  };
  const service = new WhatsAppCampaignsService(prisma, templates);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, prisma, templates };
}

describe("WhatsAppCampaignsService — panel", () => {
  it("refuses a text Meta would reject, before saving it", async () => {
    const { service, prisma } = setup();
    await expect(service.create("t1", "u1", { name: "x", body: "{{nombre}}, vuelve" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.whatsAppCampaign.create).not.toHaveBeenCalled();
  });

  it("only finds the salon's own campaigns", async () => {
    const { service } = setup({ campaign: campaignRow({ tenantId: "other" }) });
    await expect(service.submit("t1", ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.cancel("t1", ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("submits the text to Meta as a MARKETING template and schedules the campaign", async () => {
    const { service, prisma, templates } = setup({ campaign: campaignRow() });
    await service.submit("t1", ID);
    const [tenant, payload] = templates.createTemplate.mock.calls[0];
    expect(tenant).toBe("t1");
    expect(payload).toMatchObject({ name: "kr_promo_3f2a9c1e77b1_1", category: "MARKETING", language: "es" });
    expect(payload.components[0].text).toBe("Hola {{1}}, 20 % en mechas este mes.");
    expect(prisma.whatsAppCampaign.update.mock.calls[0][0].data).toMatchObject({
      templateId: "kr_promo_3f2a9c1e77b1_1",
      templateStatus: "PENDING",
      status: "scheduled",
    });
  });

  it("resubmits a rejected campaign under a new template name", async () => {
    const { service, templates } = setup({
      campaign: campaignRow({ templateId: "kr_promo_3f2a9c1e77b1_1", templateStatus: "REJECTED" }),
    });
    await service.submit("t1", ID);
    expect(templates.createTemplate.mock.calls[0][1].name).toBe("kr_promo_3f2a9c1e77b1_2");
  });

  it("says to connect WhatsApp when the salon has not", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow(),
      templates: { createTemplate: jest.fn(async () => ({ error: "not_connected" })) },
    });
    await expect(service.submit("t1", ID)).rejects.toThrow(/Conecta el WhatsApp/);
    expect(prisma.whatsAppCampaign.update).not.toHaveBeenCalled();
  });

  it("does not resubmit or edit a campaign already in review", async () => {
    const { service } = setup({ campaign: campaignRow({ status: "scheduled" }) });
    await expect(service.submit("t1", ID)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.update("t1", ID, { body: "Nuevo texto" })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("WhatsAppCampaignsService — dispatcher", () => {
  it("sends a rejected campaign back to draft with Meta's reason", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "scheduled", templateId: "kr_promo_x_1", templateStatus: "PENDING" }),
      templates: { templateReview: jest.fn(async () => ({ status: "REJECTED", reason: "PROMOTIONAL" })) },
    });
    await service.checkReviews();
    expect(prisma.whatsAppCampaign.update.mock.calls[0][0].data).toEqual({
      status: "draft",
      templateStatus: "REJECTED",
      templateReason: "PROMOTIONAL",
    });
  });

  it("starts with only the clients who opted in, not those who turned WhatsApp off", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "scheduled", templateId: "kr_promo_x_1", templateStatus: "APPROVED" }),
      accepted: ["c1", "c3"],
    });
    prisma.client.findMany.mockResolvedValueOnce([
      { id: "c1", phone: "600111222", communicationPreferences: {} },
      { id: "c2", phone: "600222333", communicationPreferences: {} }, // never opted in
      { id: "c3", phone: "600333444", communicationPreferences: { whatsapp: false } }, // channel off
    ]);
    await service.startDue(new Date("2026-10-10T10:00:00Z"));

    expect(prisma.whatsAppCampaign.updateMany.mock.calls[0][0]).toEqual({
      where: { id: ID, status: "scheduled" },
      data: { status: "sending", startedAt: new Date("2026-10-10T10:00:00Z") },
    });
    expect(prisma.whatsAppCampaignRecipient.createMany).toHaveBeenCalledWith({
      data: [{ campaignId: ID, clientId: "c1", phone: "600111222" }],
      skipDuplicates: true,
    });
    expect(prisma.whatsAppCampaign.update.mock.calls[0][0].data).toEqual({ totalRecipients: 1 });
  });

  it("finishes at once, saying why, when nobody opted in", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "scheduled", templateStatus: "APPROVED" }),
      accepted: [],
    });
    prisma.client.findMany.mockResolvedValueOnce([{ id: "c2", phone: "600222333", communicationPreferences: {} }]);
    await service.startDue(NOON);
    expect(prisma.whatsAppCampaignRecipient.createMany).not.toHaveBeenCalled();
    expect(prisma.whatsAppCampaign.update.mock.calls[0][0].data).toMatchObject({
      totalRecipients: 0,
      status: "completed",
      lastError: expect.stringContaining("Ningún cliente"),
    });
  });

  function sending(over: Record<string, any> = {}, accepted = ["c1", "c2"]) {
    const ctx = setup({
      campaign: campaignRow({ status: "sending", templateId: "kr_promo_x_1", tenant: { country: "ES" }, ...over }),
      accepted,
    });
    ctx.prisma.whatsAppCampaignRecipient.findMany.mockResolvedValueOnce([
      { id: "r1", clientId: "c1", phone: "600111222" },
      { id: "r2", clientId: "c2", phone: "600222333" },
    ]);
    ctx.prisma.client.findMany.mockResolvedValueOnce([
      { id: "c1", firstName: "Ana", status: "active", communicationPreferences: {} },
      { id: "c2", firstName: "Eva", status: "active", communicationPreferences: {} },
    ]);
    return ctx;
  }

  it("sends each recipient the approved template with their first name", async () => {
    const { service, prisma, templates } = sending();
    await service.sendBatches(NOON);
    expect(templates.sendApprovedTemplate.mock.calls.map((c: any[]) => [c[2], c[4]])).toEqual([
      ["600111222", ["Ana"]],
      ["600222333", ["Eva"]],
    ]);
    expect(templates.sendApprovedTemplate.mock.calls[0][1]).toEqual({ name: "kr_promo_x_1", language: "es" });
    expect(prisma.whatsAppCampaignRecipient.update.mock.calls[0][0]).toEqual({
      where: { id: "r1" },
      data: { status: "sent", sentAt: expect.any(Date), messageId: "wamid.1" },
    });
  });

  it("skips a client who withdrew since the campaign started", async () => {
    const { service, prisma, templates } = sending({}, ["c2"]);
    await service.sendBatches(NOON);
    expect(templates.sendApprovedTemplate).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppCampaignRecipient.update.mock.calls[0][0]).toEqual({
      where: { id: "r1" },
      data: { status: "opted_out" },
    });
  });

  it("stops the batch on Meta's rate limit and leaves the rest pending", async () => {
    const { service, prisma, templates } = sending();
    templates.sendApprovedTemplate.mockResolvedValueOnce({ sent: false, reason: "meta_130429" });
    await service.sendBatches(NOON);
    expect(templates.sendApprovedTemplate).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppCampaignRecipient.update).not.toHaveBeenCalled();
  });

  it("fails the campaign, saying why, when WhatsApp was disconnected", async () => {
    const { service, prisma, templates } = sending();
    templates.sendApprovedTemplate.mockResolvedValueOnce({ sent: false, reason: "not_connected" });
    await service.sendBatches(NOON);
    expect(prisma.whatsAppCampaign.update.mock.calls[0][0].data).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("desconectó"),
    });
  });

  it("records other refusals as failures and goes on", async () => {
    const { service, prisma, templates } = sending();
    templates.sendApprovedTemplate.mockResolvedValueOnce({ sent: false, reason: "meta_131026" });
    await service.sendBatches(NOON);
    expect(prisma.whatsAppCampaignRecipient.update.mock.calls[0][0]).toEqual({
      where: { id: "r1" },
      data: { status: "failed", externalError: "meta_131026" },
    });
    expect(templates.sendApprovedTemplate).toHaveBeenCalledTimes(2);
  });

  it("sends nothing outside 9:00-21:00 where the salon is, and carries on later", async () => {
    const { service, prisma, templates } = sending({ tenant: { country: "ES", timezone: "Europe/Madrid" } });
    await service.sendBatches(new Date("2026-10-10T20:30:00Z")); // 22:30 in Madrid
    expect(templates.sendApprovedTemplate).not.toHaveBeenCalled();
    expect(prisma.whatsAppCampaignRecipient.update).not.toHaveBeenCalled();
    await service.sendBatches(NOON);
    expect(templates.sendApprovedTemplate).toHaveBeenCalledTimes(2);
  });

  it("does not start an approved campaign at night", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "scheduled", templateStatus: "APPROVED", tenant: { timezone: "Atlantic/Canary" } }),
      accepted: ["c1"],
    });
    await service.startDue(new Date("2026-10-10T06:30:00Z")); // 7:30 in the Canaries
    expect(prisma.whatsAppCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("completes the campaign with its counts when nobody is pending", async () => {
    const { service, prisma } = setup({ campaign: campaignRow({ status: "sending", tenant: { country: "ES" } }) });
    prisma.whatsAppCampaignRecipient.groupBy.mockResolvedValueOnce([
      { status: "sent", _count: { _all: 2 } },
      { status: "delivered", _count: { _all: 3 } },
      { status: "read", _count: { _all: 1 } },
      { status: "opted_out", _count: { _all: 1 } },
    ]);
    await service.sendBatches(NOON);
    expect(prisma.whatsAppCampaign.updateMany.mock.calls[0][0]).toEqual({
      where: { id: ID, status: "sending" },
      data: expect.objectContaining({ status: "completed", sent: 6, delivered: 4, read: 1, failed: 0, optedOut: 1 }),
    });
  });
});
