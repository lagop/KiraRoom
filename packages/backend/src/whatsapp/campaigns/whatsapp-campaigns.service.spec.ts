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

function setup(
  opts: { campaign?: any; accepted?: string[]; templates?: any; connection?: any; planIncludes?: boolean } = {},
) {
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
      // B3: the status re-read before each send.
      findUnique: jest.fn(async () => ({ status: opts.campaign?.status ?? "sending" })),
    },
    whatsAppConnection: {
      findUnique: jest.fn(async () =>
        opts.connection === undefined
          ? { isActive: true, phoneNumberId: "pn1", tokenExpiresAt: null }
          : opts.connection,
      ),
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
    deleteTemplate: jest.fn(async () => ({ deleted: true })),
    ...opts.templates,
  };
  // whatsapp_marketing: Pro and Empresa (and the trial).
  const featureFlags: any = { isFeatureUnlocked: jest.fn(async () => opts.planIncludes ?? true) };
  const service = new WhatsAppCampaignsService(prisma, templates, featureFlags);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, prisma, templates, featureFlags };
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

  it("pauses the campaign, saying why, when WhatsApp was disconnected mid-batch", async () => {
    const { service, prisma, templates } = sending();
    templates.sendApprovedTemplate.mockResolvedValueOnce({ sent: false, reason: "not_connected" });
    await service.sendBatches(NOON);
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: "sending" },
      data: { status: "paused", lastError: expect.stringContaining("desconectado") },
    });
    expect(prisma.whatsAppCampaignRecipient.update).not.toHaveBeenCalled();
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

  it("completes the campaign when nobody is pending, without freezing its counts", async () => {
    const { service, prisma } = setup({ campaign: campaignRow({ status: "sending", tenant: { country: "ES" } }) });
    await service.sendBatches(NOON);
    expect(prisma.whatsAppCampaign.updateMany.mock.calls[0][0]).toEqual({
      where: { id: ID, status: "sending" },
      data: { status: "completed", completedAt: expect.any(Date) },
    });
  });
});

describe("WhatsAppCampaignsService — account-level Meta errors pause the campaign (M9)", () => {
  function sendingCampaign(over: { connection?: any } = {}) {
    const ctx = setup({
      campaign: campaignRow({ status: "sending", templateId: "kr_promo_x_1", tenant: { country: "ES" } }),
      accepted: ["c1", "c2"],
      connection: over.connection,
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

  it.each([
    ["meta_190", /caducado/], // token expired or invalid
    ["meta_131042", /método de pago/], // payment problem
    ["meta_132015", /pausado la plantilla/], // template paused
    ["meta_132016", /desactivado la plantilla/], // template disabled
    ["meta_368", /restringido o bloqueado/], // number blocked for policy
    ["meta_131031", /restringido o bloqueado/], // account locked
  ])("%s: pauses with the reason in Spanish and leaves everyone pending", async (reason, text) => {
    const { service, prisma, templates } = sendingCampaign();
    templates.sendApprovedTemplate.mockResolvedValueOnce({ sent: false, reason });
    await service.sendBatches(NOON);

    expect(templates.sendApprovedTemplate).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: "sending" },
      data: { status: "paused", lastError: expect.stringMatching(text) },
    });
    // Neither the client whose send hit the error nor the rest are failed.
    expect(prisma.whatsAppCampaignRecipient.update).not.toHaveBeenCalled();
  });

  it("checks the token expiry before a batch and sends nothing when it has passed", async () => {
    const { service, prisma, templates } = sendingCampaign({
      connection: { isActive: true, phoneNumberId: "pn1", tokenExpiresAt: new Date(NOON.getTime() - 1000) },
    });
    await service.sendBatches(NOON);
    expect(templates.sendApprovedTemplate).not.toHaveBeenCalled();
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: "sending" },
      data: { status: "paused", lastError: expect.stringContaining("caducado") },
    });
  });

  it("a token that expires later does not stop the batch", async () => {
    const { service, templates } = sendingCampaign({
      connection: { isActive: true, phoneNumberId: "pn1", tokenExpiresAt: new Date(NOON.getTime() + 86_400_000) },
    });
    await service.sendBatches(NOON);
    expect(templates.sendApprovedTemplate).toHaveBeenCalledTimes(2);
  });

  it("a per-client error (not on WhatsApp) still only fails that client", async () => {
    const { service, prisma, templates } = sendingCampaign();
    templates.sendApprovedTemplate.mockResolvedValueOnce({ sent: false, reason: "meta_131026" });
    await service.sendBatches(NOON);
    expect(prisma.whatsAppCampaign.updateMany).not.toHaveBeenCalled();
    expect(templates.sendApprovedTemplate).toHaveBeenCalledTimes(2);
  });

  function paused(over: { templates?: any; connection?: any } = {}) {
    return setup({
      campaign: campaignRow({
        status: "paused",
        templateId: "kr_promo_x_1",
        templateStatus: "APPROVED",
        lastError: "x",
        startedAt: NOON,
      }),
      templates: { templateReview: jest.fn(async () => ({ status: "APPROVED" })), ...over.templates },
      connection: over.connection,
    });
  }

  it("Reanudar: back to sending once the template is approved and the connection valid", async () => {
    const { service, prisma } = paused();
    await service.resume("t1", ID);
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: ID, tenantId: "t1", status: "paused" },
      data: { status: "sending", lastError: null, templateStatus: "APPROVED" },
    });
  });

  it("Reanudar refuses while the token is still expired", async () => {
    const { service, prisma } = paused({
      connection: { isActive: true, phoneNumberId: "pn1", tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    await expect(service.resume("t1", ID)).rejects.toThrow(/caducado/);
    expect(prisma.whatsAppCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("Reanudar refuses while Meta keeps the template paused, and records its status", async () => {
    const { service, prisma } = paused({ templates: { templateReview: jest.fn(async () => ({ status: "PAUSED" })) } });
    await expect(service.resume("t1", ID)).rejects.toThrow(/en pausa/);
    expect(prisma.whatsAppCampaign.update).toHaveBeenCalledWith({ where: { id: ID }, data: { templateStatus: "PAUSED" } });
    expect(prisma.whatsAppCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("Reanudar only applies to a paused campaign of the salon", async () => {
    const { service } = setup({ campaign: campaignRow({ status: "sending" }) });
    await expect(service.resume("t1", ID)).rejects.toBeInstanceOf(ConflictException);
    const other = setup({ campaign: campaignRow({ status: "paused", tenantId: "other" }) });
    await expect(other.service.resume("t1", ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a paused campaign can be cancelled", async () => {
    const { service, prisma } = paused();
    await service.cancel("t1", ID);
    expect(prisma.whatsAppCampaign.update.mock.calls[0][0].data).toMatchObject({ status: "cancelled" });
  });
});

describe("WhatsAppCampaignsService — counts worked out when read (M10)", () => {
  it("list adds each campaign's counts from its recipients", async () => {
    const { service, prisma } = setup({ campaign: campaignRow({ status: "completed", delivered: 0, read: 0 }) });
    prisma.whatsAppCampaignRecipient.groupBy.mockResolvedValueOnce([
      { campaignId: ID, status: "sent", _count: { _all: 2 } },
      { campaignId: ID, status: "delivered", _count: { _all: 3 } },
      { campaignId: ID, status: "read", _count: { _all: 1 } },
      { campaignId: ID, status: "failed", _count: { _all: 2 } },
      { campaignId: ID, status: "opted_out", _count: { _all: 1 } },
    ]);
    const [row] = (await service.list("t1")) as any[];
    expect(prisma.whatsAppCampaignRecipient.groupBy.mock.calls[0][0]).toMatchObject({
      by: ["campaignId", "status"],
      where: { campaignId: { in: [ID] } },
    });
    expect(row).toMatchObject({ sent: 6, delivered: 4, read: 1, failed: 2, optedOut: 1, pending: 0 });
  });

  it("get does the same for one campaign", async () => {
    const { service, prisma } = setup({ campaign: campaignRow({ status: "sending" }) });
    prisma.whatsAppCampaignRecipient.groupBy.mockResolvedValueOnce([
      { status: "read", _count: { _all: 2 } },
      { status: "pending", _count: { _all: 5 } },
    ]);
    expect(await service.get("t1", ID)).toMatchObject({ sent: 2, delivered: 2, read: 2, pending: 5 });
  });
});

describe("WhatsAppCampaignsService — cancelling mid-batch (B3)", () => {
  it("re-reads the status before each send and stops once the campaign was cancelled", async () => {
    const { service, prisma, templates } = setup({
      campaign: campaignRow({ status: "sending", templateId: "kr_promo_x_1", tenant: { country: "ES" } }),
      accepted: ["c1", "c2"],
    });
    prisma.whatsAppCampaignRecipient.findMany.mockResolvedValueOnce([
      { id: "r1", clientId: "c1", phone: "600111222" },
      { id: "r2", clientId: "c2", phone: "600222333" },
    ]);
    prisma.client.findMany.mockResolvedValueOnce([
      { id: "c1", firstName: "Ana", status: "active", communicationPreferences: {} },
      { id: "c2", firstName: "Eva", status: "active", communicationPreferences: {} },
    ]);
    prisma.whatsAppCampaign.findUnique
      .mockResolvedValueOnce({ status: "sending" })
      .mockResolvedValueOnce({ status: "cancelled" });
    await service.sendBatches(NOON);
    expect(templates.sendApprovedTemplate).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppCampaignRecipient.update).toHaveBeenCalledTimes(1);
  });
});

describe("WhatsAppCampaignsService — Meta templates are cleaned up (B4)", () => {
  it("deleting a campaign deletes its template from Meta", async () => {
    const { service, prisma, templates } = setup({
      campaign: campaignRow({ status: "completed", templateId: "kr_promo_x_1" }),
    });
    expect(await service.remove("t1", ID)).toEqual({ deleted: true });
    expect(prisma.whatsAppCampaign.delete).toHaveBeenCalledWith({ where: { id: ID } });
    expect(templates.deleteTemplate).toHaveBeenCalledWith("t1", "kr_promo_x_1");
  });

  it("a draft never submitted has no template to delete", async () => {
    const { service, templates } = setup({ campaign: campaignRow() });
    await service.remove("t1", ID);
    expect(templates.deleteTemplate).not.toHaveBeenCalled();
  });

  it("a failed deletion at Meta is logged, and the campaign is still deleted", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "cancelled", templateId: "kr_promo_x_1" }),
      templates: { deleteTemplate: jest.fn(async () => ({ deleted: false, error: "Meta down" })) },
    });
    expect(await service.remove("t1", ID)).toEqual({ deleted: true });
    expect(prisma.whatsAppCampaign.delete).toHaveBeenCalled();
    expect((service as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining("Meta down"));
  });

  it("even a deletion that throws does not fail the request", async () => {
    const { service } = setup({
      campaign: campaignRow({ status: "cancelled", templateId: "kr_promo_x_1" }),
      templates: { deleteTemplate: jest.fn(async () => Promise.reject(new Error("boom"))) },
    });
    await expect(service.remove("t1", ID)).resolves.toEqual({ deleted: true });
  });

  it("resubmitting a rejected campaign deletes the rejected template it replaces", async () => {
    const { service, templates } = setup({
      campaign: campaignRow({ templateId: "kr_promo_3f2a9c1e77b1_1", templateStatus: "REJECTED" }),
    });
    await service.submit("t1", ID);
    expect(templates.deleteTemplate).toHaveBeenCalledWith("t1", "kr_promo_3f2a9c1e77b1_1");
  });

  it("a first submission deletes nothing", async () => {
    const { service, templates } = setup({ campaign: campaignRow() });
    await service.submit("t1", ID);
    expect(templates.deleteTemplate).not.toHaveBeenCalled();
  });
});

describe("WhatsAppCampaignsService — campaigns are Pro only (whatsapp_marketing)", () => {
  function sendingCampaign(planIncludes: boolean) {
    const ctx = setup({
      campaign: campaignRow({ status: "sending", templateId: "kr_promo_x_1", tenant: { country: "ES" } }),
      accepted: ["c1"],
      planIncludes,
    });
    ctx.prisma.whatsAppCampaignRecipient.findMany.mockResolvedValueOnce([{ id: "r1", clientId: "c1", phone: "600111222" }]);
    ctx.prisma.client.findMany.mockResolvedValueOnce([
      { id: "c1", firstName: "Ana", status: "active", communicationPreferences: {} },
    ]);
    return ctx;
  }

  it("pauses a campaign that is sending when the plan does not include campaigns, saying why", async () => {
    const { service, prisma, templates, featureFlags } = sendingCampaign(false);
    await service.sendBatches(NOON);
    expect(featureFlags.isFeatureUnlocked).toHaveBeenCalledWith("t1", "whatsapp_marketing");
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: "sending" },
      data: { status: "paused", lastError: "Tu plan no incluye campañas de WhatsApp" },
    });
    expect(templates.sendApprovedTemplate).not.toHaveBeenCalled();
    expect(prisma.whatsAppCampaignRecipient.update).not.toHaveBeenCalled();
  });

  it("pauses it even outside the sending hours, so the panel says why at once", async () => {
    const { service, prisma } = sendingCampaign(false);
    await service.sendBatches(new Date("2026-10-10T22:30:00Z")); // 00:30 in Madrid
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "paused", lastError: "Tu plan no incluye campañas de WhatsApp" } }),
    );
  });

  it("keeps sending on Pro", async () => {
    const { service, templates } = sendingCampaign(true);
    await service.sendBatches(NOON);
    expect(templates.sendApprovedTemplate).toHaveBeenCalledTimes(1);
  });

  it("does not start a due campaign without the plan: it is paused, nobody is added", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "scheduled", templateStatus: "APPROVED", tenant: { timezone: "Europe/Madrid" } }),
      accepted: ["c1"],
      planIncludes: false,
    });
    await service.startDue(NOON);
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: "scheduled" },
      data: { status: "paused", lastError: "Tu plan no incluye campañas de WhatsApp" },
    });
    expect(prisma.whatsAppCampaignRecipient.createMany).not.toHaveBeenCalled();
  });

  it("Reanudar is refused while the plan does not include campaigns", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "paused", templateId: "kr_promo_x_1", lastError: "Tu plan no incluye campañas de WhatsApp" }),
      planIncludes: false,
    });
    await expect(service.resume("t1", ID)).rejects.toThrow(/Tu plan no incluye campañas de WhatsApp/);
    expect(prisma.whatsAppCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("after moving back to Pro, a campaign paused before it started goes back to the queue", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "paused", templateId: "kr_promo_x_1", templateStatus: "APPROVED", startedAt: null }),
      templates: { templateReview: jest.fn(async () => ({ status: "APPROVED" })) },
    });
    await service.resume("t1", ID);
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: ID, tenantId: "t1", status: "paused" },
      data: { status: "scheduled", lastError: null, templateStatus: "APPROVED" },
    });
  });

  it("past campaigns stay readable without the plan", async () => {
    const { service } = setup({ campaign: campaignRow({ status: "completed" }), planIncludes: false });
    await expect(service.list("t1")).resolves.toHaveLength(1);
    await expect(service.get("t1", ID)).resolves.toMatchObject({ id: ID });
    await expect(service.access("t1")).resolves.toEqual({ included: false });
  });

  it("the plan is read once per salon per dispatcher run", async () => {
    const { service, prisma, featureFlags } = setup({ planIncludes: false });
    prisma.whatsAppCampaign.findMany.mockResolvedValueOnce([
      campaignRow({ id: "a", status: "sending" }),
      campaignRow({ id: "b", status: "sending" }),
    ]);
    await service.sendBatches(NOON);
    expect(featureFlags.isFeatureUnlocked).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppCampaign.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe("WhatsAppCampaignsService — no campaigns on Sundays", () => {
  /** Sunday 11 October 2026, 12:00 in Madrid. */
  const SUNDAY_NOON = new Date("2026-10-11T10:00:00Z");
  /** Monday 12 October 2026, 9:00 in Madrid. */
  const MONDAY_NINE = new Date("2026-10-12T07:00:00Z");

  it("sends nothing on a Sunday where the salon is; the pending messages go on Monday from 9:00", async () => {
    const ctx = setup({
      campaign: campaignRow({
        status: "sending",
        templateId: "kr_promo_x_1",
        tenant: { country: "ES", timezone: "Europe/Madrid" },
      }),
      accepted: ["c1"],
    });
    ctx.prisma.whatsAppCampaignRecipient.findMany.mockResolvedValue([{ id: "r1", clientId: "c1", phone: "600111222" }]);
    ctx.prisma.client.findMany.mockResolvedValue([
      { id: "c1", firstName: "Ana", status: "active", communicationPreferences: {} },
    ]);
    await ctx.service.sendBatches(SUNDAY_NOON);
    expect(ctx.templates.sendApprovedTemplate).not.toHaveBeenCalled();
    expect(ctx.prisma.whatsAppCampaignRecipient.update).not.toHaveBeenCalled();
    await ctx.service.sendBatches(new Date("2026-10-12T06:59:00Z")); // Monday 8:59
    expect(ctx.templates.sendApprovedTemplate).not.toHaveBeenCalled();
    await ctx.service.sendBatches(MONDAY_NINE);
    expect(ctx.templates.sendApprovedTemplate).toHaveBeenCalledTimes(1);
  });

  it("does not start an approved campaign on a Sunday", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "scheduled", templateStatus: "APPROVED", tenant: { timezone: "Europe/Madrid" } }),
      accepted: ["c1"],
    });
    await service.startDue(SUNDAY_NOON);
    expect(prisma.whatsAppCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("goes by the salon's own day: Sunday 10:00 in Tokyo is still Saturday in Madrid", async () => {
    const { service, prisma } = setup({
      campaign: campaignRow({ status: "scheduled", templateStatus: "APPROVED", tenant: { timezone: "Asia/Tokyo" } }),
      accepted: ["c1"],
    });
    await service.startDue(new Date("2026-10-11T01:00:00Z"));
    expect(prisma.whatsAppCampaign.updateMany).not.toHaveBeenCalled();
  });
});
