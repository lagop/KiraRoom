import { Prisma } from "@prisma/client";
import { EmailSuppressionService } from "./email-suppression.service";
import { ResendEventsService, ResendWebhookEvent } from "./resend-events.service";

/**
 * What Resend's delivery events do to a campaign.
 *
 * The panel showed opens, clicks and bounces that never moved (the webhook
 * was unreachable) and a "delivered" that was really "accepted by Resend".
 * These tests run real event sequences -- including the redeliveries and
 * out-of-order arrivals Svix produces -- against an in-memory store, and
 * check the numbers the salon would see and the addresses that stop
 * receiving marketing.
 */

type Row = Record<string, any>;

function fakePrisma() {
  const db = {
    campaigns: [] as Row[],
    recipients: [] as Row[],
    analytics: [] as Row[],
    suppressions: [] as Row[],
    users: [] as Row[],
    deliveries: [] as Row[],
  };

  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && "in" in v) return (v.in as unknown[]).includes(row[k]);
      if (v === null) return row[k] === null || row[k] === undefined;
      return row[k] === v;
    });

  const prisma: any = {
    emailCampaignRecipient: {
      findFirst: async ({ where }: any) => {
        const r = db.recipients.find((x) => matches(x, where));
        if (!r) return null;
        const c = db.campaigns.find((x) => x.id === r.campaignId);
        return { id: r.id, email: r.email, campaignId: r.campaignId, campaign: { tenantId: c.tenantId } };
      },
      updateMany: async ({ where, data }: any) => {
        const hit = db.recipients.filter((x) => matches(x, where));
        hit.forEach((x) => Object.assign(x, data));
        return { count: hit.length };
      },
      update: async ({ where, data }: any) => Object.assign(db.recipients.find((x) => x.id === where.id), data),
    },
    emailCampaign: {
      update: async ({ where, data }: any) => {
        const c = db.campaigns.find((x) => x.id === where.id);
        for (const [k, v] of Object.entries<any>(data)) c[k] = v?.increment ? (c[k] ?? 0) + v.increment : v;
        return c;
      },
    },
    emailCampaignAnalytics: {
      findUnique: async ({ where }: any) => db.analytics.find((x) => x.eventId === where.eventId) ?? null,
      create: async ({ data }: any) => {
        if (db.analytics.some((x) => x.eventId === data.eventId)) {
          throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
        }
        db.analytics.push(data);
        return data;
      },
    },
    emailSuppression: {
      upsert: async ({ where, create }: any) => {
        const key = where.tenantId_email;
        const found = db.suppressions.find((x) => x.tenantId === key.tenantId && x.email === key.email);
        if (found) return found;
        db.suppressions.push(create);
        return create;
      },
      findMany: async ({ where }: any) =>
        db.suppressions.filter((x) => x.tenantId === where.tenantId && where.email.in.includes(x.email)),
      count: async ({ where }: any) => db.suppressions.filter((x) => x.tenantId === where.tenantId).length,
    },
    notificationDelivery: {
      updateMany: async ({ where, data }: any) => {
        const hit = db.deliveries.filter((x) => matches(x, where));
        hit.forEach((x) => Object.assign(x, data));
        return { count: hit.length };
      },
    },
    user: {
      updateMany: async ({ where, data }: any) => {
        const hit = db.users.filter((x) => matches(x, where));
        hit.forEach((x) => Object.assign(x, data));
        return { count: hit.length };
      },
    },
  };
  return { db, prisma };
}

function setup() {
  const { db, prisma } = fakePrisma();
  db.campaigns.push({ id: "camp-1", tenantId: "tenant-a", emailsDelivered: 0, emailsOpened: 0, clicks: 0, bounces: 0, complaints: 0 });
  for (const n of [1, 2, 3]) {
    db.recipients.push({
      id: `rcp-${n}`,
      campaignId: "camp-1",
      email: `Clienta${n}@Example.test`,
      status: "sent",
      messageId: `re_${n}`,
      deliveredAt: null,
      openedAt: null,
      clickedAt: null,
      bouncedAt: null,
      complainedAt: null,
    });
  }
  const suppressions = new EmailSuppressionService(prisma);
  const service = new ResendEventsService(prisma, suppressions);
  (service as any).logger = { log: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  let seq = 0;
  const send = (type: string, emailId: string, extra: Partial<ResendWebhookEvent["data"]> = {}, eventId = `msg_${++seq}`) =>
    service.handle({ type, created_at: "2026-10-02T10:00:00.000Z", data: { email_id: emailId, ...extra } }, eventId);
  const campaign = () => db.campaigns[0];
  const recipient = (n: number) => db.recipients.find((r) => r.id === `rcp-${n}`);
  return { db, send, campaign, recipient, suppressions };
}

describe("ResendEventsService", () => {
  it("counts delivered, opened and clicked per recipient", async () => {
    const { send, campaign, recipient } = setup();
    await send("email.delivered", "re_1");
    await send("email.delivered", "re_2");
    await send("email.opened", "re_1");
    await send("email.clicked", "re_1", { click: { link: "https://salon.example.test/promo" } });

    expect(campaign()).toMatchObject({ emailsDelivered: 2, emailsOpened: 1, clicks: 1, bounces: 0 });
    expect(recipient(1).status).toBe("clicked");
    expect(recipient(2).status).toBe("delivered");
  });

  it("counts a recipient who opens five times as one open", async () => {
    const { send, campaign, db } = setup();
    for (let i = 0; i < 5; i++) await send("email.opened", "re_1");
    expect(campaign().emailsOpened).toBe(1);
    // Every open is still in the event log.
    expect(db.analytics.filter((a) => a.eventType === "opened")).toHaveLength(5);
  });

  it("ignores a redelivered event (same svix-id)", async () => {
    const { send, campaign, db } = setup();
    await send("email.clicked", "re_1", {}, "msg_same");
    await send("email.clicked", "re_1", {}, "msg_same");
    expect(campaign().clicks).toBe(1);
    expect(db.analytics).toHaveLength(1);
  });

  it("does not move a recipient back when 'delivered' arrives after 'opened'", async () => {
    const { send, recipient, campaign } = setup();
    await send("email.opened", "re_1");
    await send("email.delivered", "re_1");
    expect(recipient(1).status).toBe("opened");
    expect(campaign().emailsDelivered).toBe(1);
  });

  it("suppresses an address after a permanent bounce, for that salon", async () => {
    const { send, campaign, recipient, suppressions } = setup();
    await send("email.bounced", "re_2", { bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist" } });

    expect(campaign().bounces).toBe(1);
    expect(recipient(2)).toMatchObject({ status: "bounced", errorMessage: "Mailbox does not exist" });
    expect(await suppressions.suppressedAmong("tenant-a", ["clienta2@example.test"])).toEqual(new Set(["clienta2@example.test"]));
    expect(await suppressions.suppressedAmong("tenant-b", ["clienta2@example.test"])).toEqual(new Set());
  });

  it("counts a temporary bounce but keeps the address", async () => {
    const { send, campaign, db } = setup();
    await send("email.bounced", "re_3", { bounce: { type: "Temporary", message: "Mailbox full" } });
    expect(campaign().bounces).toBe(1);
    expect(db.suppressions).toHaveLength(0);
  });

  it("suppresses an address that marked the email as spam", async () => {
    const { send, campaign, recipient, db } = setup();
    await send("email.complained", "re_1");
    expect(campaign().complaints).toBe(1);
    expect(recipient(1).status).toBe("complained");
    expect(db.suppressions).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", email: "clienta1@example.test", reason: "complaint" }),
    ]);
  });

  it("stamps the user when a non-campaign (transactional) email hard-bounces", async () => {
    const { send, db } = setup();
    db.users.push({ id: "u1", email: "owner@salon.example.test", emailBouncedAt: null });
    db.deliveries.push({ externalId: "re_tx", status: "SENT" });
    await send("email.bounced", "re_tx", { to: ["Owner@Salon.example.test"], bounce: { type: "Permanent", message: "No such user" } });

    expect(db.users[0].emailBouncedAt).toBeInstanceOf(Date);
    expect(db.deliveries[0].status).toBe("BOUNCED");
    expect(db.campaigns[0].bounces).toBe(0);
  });

  it("ignores event types it does not track", async () => {
    const { send, campaign, db } = setup();
    await send("email.sent", "re_1");
    await send("domain.updated", "re_1");
    expect(campaign()).toMatchObject({ emailsDelivered: 0, emailsOpened: 0 });
    expect(db.analytics).toHaveLength(0);
  });
});
