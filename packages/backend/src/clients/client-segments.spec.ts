import { ClientsService, tagsFilter } from "./clients.service";
import { inactiveFilter } from "../whatsapp/campaigns/whatsapp-campaigns.service";
import { EmailCampaignsScheduler } from "../email-campaigns/email-campaigns.scheduler";

/**
 * Who a campaign reaches by tags or by inactivity.
 *
 * - The tag filter used `hasSome`, which only exists for Postgres array
 *   columns; `tags` is JSON, so Prisma refused the query and the campaign
 *   screen's filter answered 500.
 * - "Inactive" included clients with no last visit at all, and since no
 *   visit was ever recorded, that was every client. The owner's rule:
 *   campaigns go only to clients with at least one completed visit.
 */

describe("tags filter", () => {
  it("matches any of the tags with array_contains on the JSON column", () => {
    expect(tagsFilter(["vip", " novia ", "vip", ""])).toEqual({
      OR: [{ tags: { array_contains: ["vip"] } }, { tags: { array_contains: ["novia"] } }],
    });
  });

  it("no tags, no filter", () => {
    expect(tagsFilter([])).toBeNull();
    expect(tagsFilter(undefined)).toBeNull();
    expect(tagsFilter([" ", ""])).toBeNull();
  });

  it("is what the campaign screen's filter queries, never hasSome", async () => {
    const findMany = jest.fn(async () => []);
    const service = new ClientsService({ client: { findMany } } as any);

    await service.findAllWithFilters("t1", { tags: ["vip", "rubias"], hasEmail: true });

    const where = (findMany.mock.calls[0] as any[])[0].where;
    expect(JSON.stringify(where)).not.toContain("hasSome");
    expect(where).toMatchObject({
      tenantId: "t1",
      status: "active",
      email: { not: null },
      AND: [{ OR: [{ tags: { array_contains: ["vip"] } }, { tags: { array_contains: ["rubias"] } }] }],
    });
  });
});

describe("inactive clients: only those who came at least once", () => {
  const now = new Date("2026-11-01T10:00:00Z");

  it("WhatsApp 'sin venir desde hace N días' leaves out clients with no completed visit", () => {
    const where = inactiveFilter(60, now);
    expect(where).toEqual({ lastVisit: { lt: new Date("2026-09-02T10:00:00Z") } });
    expect(JSON.stringify(where)).not.toContain("null");
    expect(inactiveFilter(null, now)).toEqual({});
  });

  it("the re-engagement email asks for a last visit before the threshold, never a missing one", async () => {
    const findMany = jest.fn(async () => []);
    const prisma: any = {
      client: { findMany },
      consent: { findMany: jest.fn(async () => []) },
      emailCampaign: { update: jest.fn(async () => ({})) },
    };
    const s = new EmailCampaignsScheduler(
      prisma,
      {} as any, // email
      { suppressedAmong: jest.fn(async () => new Set()) } as any,
      {} as any, // unsubscribe links
      {} as any, // pacer
      { limits: async () => ({ tenantId: "t1", month: "2026-11", cap: 1e9, resetsOn: "2026-12-01" }), reserve: async () => ({ ok: true, tenantId: "t1", month: "2026-11", source: "plan" }), release: async () => undefined, pause: async () => undefined, resumePaused: async () => 0 } as any, // quota: no cap here
    );
    (s as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await (s as any).processReengagementCampaign({ id: "camp", tenantId: "t1", inactiveDaysThreshold: 45 });

    const where = (findMany.mock.calls[0] as any[])[0].where;
    expect(where.OR).toBeUndefined();
    expect(where.lastVisit).toEqual({ lt: expect.any(Date) });
    const days = (Date.now() - where.lastVisit.lt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(45);
  });
});
