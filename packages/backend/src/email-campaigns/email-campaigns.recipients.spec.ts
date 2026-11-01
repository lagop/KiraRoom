import { BadRequestException } from "@nestjs/common";
import { EmailCampaignsService, RECIPIENT_CLIENT_SELECT } from "./email-campaigns.service";
import { EmailCampaignsScheduler } from "./email-campaigns.scheduler";

/**
 * Who a campaign reaches.
 *
 * "Enviar a todos" posted the id of every client the panel listed, blocked
 * and inactive ones included; adding recipients had no status filter, and a
 * client added twice (picked first, then "Enviar a todos", or a double
 * click) got the campaign twice. A campaign now reaches the salon's active
 * clients only, when recipients are added and again when it sends, and a
 * client is on a campaign's list once.
 */

type ClientRow = {
  id: string;
  tenantId: string;
  status: string;
  email: string | null;
  firstName: string;
  lastName: string;
  lastVisit: Date | null;
};

const VISITED = new Date("2026-09-01");
const CLIENTS: ClientRow[] = [
  { id: "ana", tenantId: "t1", status: "active", email: "ana@example.test", firstName: "Ana", lastName: "López", lastVisit: VISITED },
  { id: "bea", tenantId: "t1", status: "blocked", email: "bea@example.test", firstName: "Bea", lastName: "Ruiz", lastVisit: VISITED },
  { id: "eva", tenantId: "t1", status: "inactive", email: "eva@example.test", firstName: "Eva", lastName: "Gil", lastVisit: VISITED },
  { id: "sin-email", tenantId: "t1", status: "active", email: null, firstName: "Sin", lastName: "Email", lastVisit: VISITED },
  { id: "otra", tenantId: "t2", status: "active", email: "otra@example.test", firstName: "Otra", lastName: "Salón", lastVisit: VISITED },
  // Never came: no completed visit, so no prior relationship (LSSI 21.2).
  { id: "nueva", tenantId: "t1", status: "active", email: "nueva@example.test", firstName: "Nueva", lastName: "Ruiz", lastVisit: null },
  { id: "rechaza", tenantId: "t1", status: "active", email: "rechaza@example.test", firstName: "Re", lastName: "Chaza", lastVisit: VISITED },
  { id: "baja", tenantId: "t1", status: "active", email: "Baja@example.test", firstName: "Ba", lastName: "Ja", lastVisit: VISITED },
];

function setup(
  opts: {
    status?: string;
    campaignType?: string;
    existing?: Array<{ campaignId: string; clientId: string | null; status: string }>;
  } = {},
) {
  const rows: any[] = (opts.existing ?? []).map((r, i) => ({ id: `old${i}`, email: "x@example.test", ...r }));
  const clientQueries: any[] = [];
  const prisma: any = {
    emailCampaign: {
      findFirst: jest.fn(async () => ({
        id: "camp",
        tenantId: "t1",
        status: opts.status ?? "draft",
        campaignType: opts.campaignType ?? "newsletter",
      })),
      update: jest.fn(async () => ({})),
    },
    client: {
      findMany: jest.fn(async ({ where }: any) => {
        clientQueries.push(where);
        return CLIENTS.filter(
          (c) =>
            c.tenantId === where.tenantId &&
            (!where.status || c.status === where.status) &&
            (!where.email || c.email !== null) &&
            (!where.lastVisit || c.lastVisit !== null) &&
            (!where.id?.in || where.id.in.includes(c.id)),
        );
      }),
    },
    // "rechaza" said no to promotions (marketing-consent.spec covers how).
    consent: {
      findMany: jest.fn(async ({ where }: any) =>
        where.tenantId === "t1" && (!where.clientId || where.clientId.in.includes("rechaza"))
          ? [{ clientId: "rechaza", responses: { accepts: false } }]
          : [],
      ),
    },
    emailCampaignRecipient: {
      // Like Postgres with the (campaignId, clientId) unique index and
      // skipDuplicates: rows already there are skipped, not returned.
      createManyAndReturn: jest.fn(async ({ data, skipDuplicates }: any) => {
        const added: any[] = [];
        for (const d of data) {
          const clash = rows.some((r) => r.campaignId === d.campaignId && r.clientId === d.clientId);
          if (clash && !skipDuplicates) throw new Error("unique violation");
          if (clash) continue;
          const row = { id: `r${rows.length + 1}`, ...d };
          rows.push(row);
          added.push(row);
        }
        return added;
      }),
      count: jest.fn(async ({ where }: any) =>
        rows.filter((r) => r.campaignId === where.campaignId && r.status === where.status).length,
      ),
    },
  };
  const email: any = { isConfigured: () => true };
  // "baja" used the unsubscribe link: on the suppression list.
  const suppressions: any = {
    suppressedAmong: jest.fn(async (_t: string, emails: string[]) =>
      new Set(emails.map((e) => e?.toLowerCase()).filter((e) => e === "baja@example.test")),
    ),
  };
  const service = new EmailCampaignsService(prisma, email, suppressions, { kick: jest.fn() } as any);
  return { service, prisma, rows, clientQueries };
}

describe("adding recipients to a campaign", () => {
  it("adds only the salon's active clients with an email", async () => {
    const { service, rows, clientQueries } = setup();

    const result = await service.addRecipients("t1", "camp", ["ana", "bea", "eva", "sin-email", "otra"]);

    expect(rows.map((r) => r.clientId)).toEqual(["ana"]);
    expect(clientQueries[0]).toMatchObject({ tenantId: "t1", status: "active", email: { not: null } });
    expect(result).toEqual({ added: 1, alreadyAdded: 0, excluded: 4 });
  });

  it("adds only clients with a completed visit, who accept promotions and are not suppressed", async () => {
    const { service, rows, clientQueries } = setup();

    const result = await service.addRecipients("t1", "camp", ["ana", "nueva", "rechaza", "baja"]);

    expect(rows.map((r) => r.clientId)).toEqual(["ana"]);
    expect(clientQueries[0]).toMatchObject({ lastVisit: { not: null } });
    expect(result).toEqual({ added: 1, alreadyAdded: 0, excluded: 3 });
  });

  it("refuses a re-engagement campaign: it picks its own clients", async () => {
    const { service, rows } = setup({ campaignType: "reengagement" });
    await expect(service.addRecipients("t1", "camp", ["ana"])).rejects.toThrow(/reactivación/);
    expect(rows).toHaveLength(0);
  });

  it("never puts a client on the list twice, and counts only who was added", async () => {
    const { service, prisma, rows } = setup({ existing: [{ campaignId: "camp", clientId: "ana", status: "pending" }] });

    const added = await service.addRecipients("t1", "camp", ["ana", "ana"]);

    expect(added).toEqual({ added: 0, alreadyAdded: 1, excluded: 0 });
    expect(rows.filter((r) => r.clientId === "ana")).toHaveLength(1);
    expect(prisma.emailCampaignRecipient.createManyAndReturn.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(prisma.emailCampaign.update.mock.calls[0][0].data).toEqual({ totalRecipients: { increment: 0 } });
  });

  it("refuses a campaign already sent, being sent or archived as sent", async () => {
    for (const status of ["sent", "sending", "failed", "active"]) {
      const { service } = setup({ status });
      await expect(service.addRecipients("t1", "camp", ["ana"])).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe("Enviar a todos", () => {
  it("adds every client the campaign may reach, and sends", async () => {
    const { service, rows, clientQueries } = setup();
    const send = jest.spyOn(service, "sendCampaignNow").mockResolvedValue({ success: true } as any);

    await service.sendToAllClients("t1", "camp");

    expect(clientQueries[0].id).toBeUndefined();
    expect(rows.map((r) => r.clientId)).toEqual(["ana"]);
    expect(send).toHaveBeenCalledWith("t1", "camp");
  });

  it("does not add a client picked before a second time", async () => {
    const { service, rows } = setup({ existing: [{ campaignId: "camp", clientId: "ana", status: "pending" }] });
    jest.spyOn(service, "sendCampaignNow").mockResolvedValue({ success: true } as any);

    await service.sendToAllClients("t1", "camp");

    expect(rows.filter((r) => r.clientId === "ana")).toHaveLength(1);
  });

  it("says so when nobody can receive it, instead of sending to no one", async () => {
    const { service, prisma } = setup();
    prisma.client.findMany.mockResolvedValue([]);
    const send = jest.spyOn(service, "sendCampaignNow");

    await expect(service.sendToAllClients("t1", "camp")).rejects.toThrow(/No hay clientas que puedan recibirla/);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a campaign already sent, before adding anyone", async () => {
    const { service, rows } = setup({ status: "sent" });
    await expect(service.sendToAllClients("t1", "camp")).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });
});

describe("a campaign's recipient list", () => {
  it("shows who each client is, not her whole record", async () => {
    const findFirst = jest.fn(async () => ({ recipients: [] }));
    const service = new EmailCampaignsService({ emailCampaign: { findFirst } } as any, {} as any, {} as any, {} as any);

    await service.getCampaignRecipients("t1", "camp");

    const include = (findFirst.mock.calls[0] as any[])[0].include;
    expect(include.recipients.include.client).toEqual({ select: RECIPIENT_CLIENT_SELECT });
    expect(Object.keys(RECIPIENT_CLIENT_SELECT).sort()).toEqual(["email", "firstName", "id", "lastName", "status"]);
  });
});

describe("re-engagement: a client is on the campaign's list once", () => {
  function scheduler(existing: boolean) {
    const prisma: any = {
      client: {
        findMany: jest.fn(async () => [
          { id: "ana", email: "ana@example.test", firstName: "Ana", lastName: "López", lastReengagementSent: null },
        ]),
        update: jest.fn(async () => ({})),
      },
      consent: { findMany: jest.fn(async () => []) },
      emailCampaignRecipient: {
        findUnique: jest.fn(async () => (existing ? { id: "row-ana" } : null)),
        update: jest.fn(async () => ({})),
        create: jest.fn(async () => ({})),
      },
      emailCampaign: { update: jest.fn(async () => ({})) },
    };
    const email: any = { sendEmail: jest.fn(async () => ({ success: true, id: "re_2" })) };
    const suppressions: any = { suppressedAmong: jest.fn(async () => new Set()) };
    const unsubscribes: any = { link: () => ({ pageUrl: "https://app.test/baja", headers: {} }), withFooter: (h: string) => h };
    const pacer: any = { wait: jest.fn(async () => undefined) };
    const s = new EmailCampaignsScheduler(prisma, email, suppressions, unsubscribes, pacer);
    (s as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const campaign = { id: "camp", tenantId: "t1", subject: "Te echamos de menos", content: "<p>Hola</p>", tenant: { name: "Salón" } };
    return { run: () => (s as any).processReengagementCampaign(campaign), prisma };
  }

  it("updates her row to the latest email instead of adding another", async () => {
    const { run, prisma } = scheduler(true);

    await run();

    expect(prisma.emailCampaignRecipient.create).not.toHaveBeenCalled();
    expect(prisma.emailCampaignRecipient.update).toHaveBeenCalledWith({
      where: { id: "row-ana" },
      data: expect.objectContaining({ status: "sent", messageId: "re_2", openedAt: null, deliveredAt: null }),
    });
    expect(prisma.emailCampaign.update.mock.calls[0][0].data).toEqual({
      totalRecipients: { increment: 0 },
      emailsSent: { increment: 1 },
    });
  });

  it("adds her the first time", async () => {
    const { run, prisma } = scheduler(false);

    await run();

    expect(prisma.emailCampaignRecipient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ campaignId: "camp", clientId: "ana", status: "sent", messageId: "re_2" }),
    });
    expect(prisma.emailCampaign.update.mock.calls[0][0].data).toEqual({
      totalRecipients: { increment: 1 },
      emailsSent: { increment: 1 },
    });
  });
});
