import { BadRequestException, ConflictException } from "@nestjs/common";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { bodyParser } from "../common/validation/validated-body.testing";
import { EmailCampaignsController } from "./email-campaigns.controller";
import { EmailCampaignsService } from "./email-campaigns.service";

/**
 * What a salon can do with a campaign, by state.
 *
 * - A campaign that emailed anyone is archived, never deleted (deleting it
 *   removed the recipient rows the unsubscribe links point to).
 * - A scheduled campaign can be taken back to draft ("Desprogramar");
 *   only a draft is edited.
 * - "Desactivar" is for an active re-engagement campaign only: it used to
 *   move any campaign, a sending one included, back to draft.
 * - Empty optional fields from the forms are "not given", not a 400 or a
 *   foreign-key 500.
 */

type Row = Record<string, any>;

function setup(campaign: Row, recipients: Row[] = []) {
  const row: Row = {
    id: "c1",
    tenantId: "t1",
    campaignType: "newsletter",
    status: "draft",
    archivedAt: null,
    scheduledAt: null,
    ...campaign,
  };
  const match = (where: Row) =>
    where.id === row.id &&
    where.tenantId === row.tenantId &&
    (where.status === undefined ||
      (typeof where.status === "string" ? where.status === row.status : where.status.in.includes(row.status))) &&
    (where.campaignType === undefined || where.campaignType === row.campaignType);
  const prisma: any = {
    emailCampaign: {
      findFirst: jest.fn(async ({ where }: any) => (match(where) ? row : null)),
      findFirstOrThrow: jest.fn(async () => row),
      findMany: jest.fn(async () => [row]),
      update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!match(where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      delete: jest.fn(async () => row),
    },
    emailCampaignRecipient: {
      count: jest.fn(async ({ where }: any) =>
        recipients.filter(
          (r) =>
            (where.status === undefined || r.status === where.status) &&
            (where.sentAt === undefined || (r.sentAt !== null && r.sentAt !== undefined)),
        ).length,
      ),
      groupBy: jest.fn(async () => [
        { campaignId: "c1", status: "pending", _count: { _all: 2 } },
        { campaignId: "c1", status: "sending", _count: { _all: 1 } },
        { campaignId: "c1", status: "failed", _count: { _all: 4 } },
      ]),
    },
  };
  const email: any = { isConfigured: () => true };
  const service = new EmailCampaignsService(prisma, email, {} as any, { kick: jest.fn() } as any);
  return { service, prisma, row };
}

describe("deleting and archiving", () => {
  it("deletes a draft that never emailed anyone", async () => {
    const { service, prisma } = setup({ status: "draft" });
    await expect(service.deleteCampaign("t1", "c1")).resolves.toEqual({ success: true });
    expect(prisma.emailCampaign.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("refuses to delete a sent, sending or scheduled campaign, or one that already emailed someone", async () => {
    for (const [status, recipients] of [
      ["sent", []],
      ["sending", []],
      ["active", []],
      ["scheduled", []], // unschedule it first
      ["failed", [{ status: "sent", sentAt: new Date() }]],
      ["draft", [{ status: "sent", sentAt: new Date() }]], // a re-engagement campaign that ran, then was stopped
    ] as Array<[string, Row[]]>) {
      const { service, prisma } = setup({ status }, recipients);
      await expect(service.deleteCampaign("t1", "c1")).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.emailCampaign.delete).not.toHaveBeenCalled();
    }
  });

  it("archives a sent campaign, keeping it, and brings it back", async () => {
    const { service, row } = setup({ status: "sent" });
    await service.archiveCampaign("t1", "c1");
    expect(row.archivedAt).toBeInstanceOf(Date);
    await service.unarchiveCampaign("t1", "c1");
    expect(row.archivedAt).toBeNull();
  });

  it("does not archive a campaign that is sending, scheduled or active", async () => {
    for (const status of ["sending", "scheduled", "active"]) {
      const { service, row } = setup({ status });
      await expect(service.archiveCampaign("t1", "c1")).rejects.toBeInstanceOf(BadRequestException);
      expect(row.archivedAt).toBeNull();
    }
  });

  it("lists archived campaigns only under the Archivadas filter, with their pending and failed counts", async () => {
    const { service, prisma } = setup({ status: "sent" });
    const list: any[] = await service.getCampaigns("t1");
    expect(prisma.emailCampaign.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", archivedAt: null });
    expect(list[0]).toMatchObject({ pendingCount: 3, failedCount: 4 });

    await service.getCampaigns("t1", undefined, undefined, true);
    expect(prisma.emailCampaign.findMany.mock.calls[1][0].where).toEqual({ tenantId: "t1", archivedAt: { not: null } });
  });
});

describe("scheduling", () => {
  it("refuses to schedule with nobody to send to, or in the past", async () => {
    const empty = setup({ status: "draft" });
    await expect(empty.service.scheduleCampaign("t1", "c1", new Date(Date.now() + 3_600_000))).rejects.toThrow(/no tiene destinatarias/);
    expect(empty.row.status).toBe("draft");

    const past = setup({ status: "draft" }, [{ status: "pending" }]);
    await expect(past.service.scheduleCampaign("t1", "c1", new Date(Date.now() - 3_600_000))).rejects.toThrow(/no hayan pasado/);
  });

  it("schedules a draft with recipients", async () => {
    const { service, row } = setup({ status: "draft" }, [{ status: "pending" }]);
    const at = new Date(Date.now() + 3_600_000);
    await service.scheduleCampaign("t1", "c1", at);
    expect(row).toMatchObject({ status: "scheduled", scheduledAt: at });
  });

  it("Desprogramar takes a scheduled campaign back to draft", async () => {
    const { service, row } = setup({ status: "scheduled", scheduledAt: new Date() });
    await service.unscheduleCampaign("t1", "c1");
    expect(row).toMatchObject({ status: "draft", scheduledAt: null });
  });

  it("Desprogramar refuses a campaign that is not scheduled", async () => {
    const { service } = setup({ status: "sending" });
    await expect(service.unscheduleCampaign("t1", "c1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("edits only a draft", async () => {
    const scheduled = setup({ status: "scheduled" });
    await expect(scheduled.service.updateCampaign("t1", "c1", { name: "x" })).rejects.toThrow(/Desprográmala/);
    const sent = setup({ status: "sent" });
    await expect(sent.service.updateCampaign("t1", "c1", { name: "x" })).rejects.toThrow(/borrador/);
    const draft = setup({ status: "draft" });
    await draft.service.updateCampaign("t1", "c1", { name: "Nuevo", replyTo: "" });
    expect(draft.row).toMatchObject({ name: "Nuevo", replyTo: null });
  });

  it("does not turn a one-shot campaign into a re-engagement one", async () => {
    const { service } = setup({ status: "draft" });
    await expect(service.updateCampaign("t1", "c1", { campaignType: "reengagement" as any })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.createCampaign("t1", { campaignType: "reengagement" } as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("Desactivar", () => {
  it("stops an active re-engagement campaign", async () => {
    const { service, row } = setup({ status: "active", campaignType: "reengagement" });
    await service.deactivateCampaign("t1", "c1");
    expect(row.status).toBe("draft");
  });

  it("refuses any other campaign or state: a sending campaign must not go back to draft", async () => {
    for (const c of [
      { status: "sending", campaignType: "newsletter" },
      { status: "sent", campaignType: "newsletter" },
      { status: "draft", campaignType: "reengagement" },
      { status: "sending", campaignType: "reengagement" },
    ]) {
      const { service, row } = setup(c);
      await expect(service.deactivateCampaign("t1", "c1")).rejects.toBeInstanceOf(BadRequestException);
      expect(row.status).toBe(c.status);
    }
  });
});

describe("who may do it", () => {
  const roles = (method: string) => Reflect.getMetadata(ROLES_KEY, (EmailCampaignsController.prototype as any)[method]);

  it("owner and admin delete, archive, unschedule and retry", () => {
    for (const method of ["deleteCampaign", "archiveCampaign", "unarchiveCampaign", "unscheduleCampaign", "retryFailed"]) {
      expect(roles(method)).toEqual(["owner", "admin"]);
    }
  });
});

describe("campaign bodies", () => {
  const reengagement = bodyParser(EmailCampaignsController, "createReengagementCampaign");
  const create = bodyParser(EmailCampaignsController, "createCampaign");

  it("take an empty reply-to, promotion or preview text as not given", async () => {
    const out = await reengagement({
      name: "Vuelve",
      subject: "Te echamos de menos",
      content: "<p>Hola</p>",
      inactiveDaysThreshold: 30,
      linkedPromotionId: "",
      replyTo: "",
      previewText: "",
      fromName: "",
    });
    expect(out.linkedPromotionId).toBeUndefined();
    expect(out.replyTo).toBeUndefined();
    expect(out.previewText).toBeUndefined();

    const campaign = await create({ name: "Otoño", subject: "Ofertas", content: "<p>x</p>", campaignType: "newsletter", replyTo: "  " });
    expect(campaign.replyTo).toBeUndefined();
  });

  it("still refuse a reply-to that is not an address, and a promotion id that is not one", async () => {
    await expect(
      reengagement({ name: "V", subject: "S", content: "c", inactiveDaysThreshold: 30, replyTo: "no-es-email" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      reengagement({ name: "V", subject: "S", content: "c", inactiveDaysThreshold: 30, linkedPromotionId: "x" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("the recipient picker's audience", () => {
  it("says who cannot receive campaigns, and why, each client under one reason", async () => {
    const visit = new Date("2026-09-01");
    const prisma: any = {
      client: {
        findMany: jest.fn(async () => [
          { id: "ana", email: "ana@example.test", status: "active", lastVisit: visit },
          { id: "nueva", email: "nueva@example.test", status: "active", lastVisit: null },
          { id: "rechaza", email: "r@example.test", status: "active", lastVisit: null },
          { id: "baja", email: "Baja@example.test", status: "active", lastVisit: visit },
          { id: "sin", email: null, status: "active", lastVisit: visit },
          { id: "bloq", email: "b@example.test", status: "blocked", lastVisit: visit },
        ]),
      },
      consent: { findMany: jest.fn(async () => [{ clientId: "rechaza", responses: { accepts: false } }]) },
    };
    const suppressions: any = { suppressedAmong: jest.fn(async () => new Set(["baja@example.test"])) };
    const service = new EmailCampaignsService(prisma, {} as any, suppressions, {} as any);

    const audience = await service.getAudience("t1");

    expect(prisma.client.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(audience).toEqual({
      reachable: 1,
      excluded: { inactive: 1, no_email: 1, refused: 1, suppressed: 1, no_visit: 1 },
      clients: { nueva: "no_visit", rechaza: "refused", baja: "suppressed", sin: "no_email", bloq: "inactive" },
    });
  });
});
