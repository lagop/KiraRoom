import { BadRequestException } from "@nestjs/common";
import { EmailCampaignsService } from "./email-campaigns.service";
import { EmailCampaignSender, MAX_SEND_ATTEMPTS, SEND_LEASE_MS, campaignSender, retryDelayMs } from "./email-campaign-sender.service";
import { EmailUnsubscribeService } from "./email-unsubscribe.service";
import { EmailQuotaService } from "./email-quota.service";
import { creditEmailPackFromCheckout } from "./email-packs.service";

/**
 * Sending a campaign.
 *
 * Before: every email went out inside the HTTP request, one after another,
 * so a restart left the campaign "sending" for ever, a 429 was a permanent
 * failure, and a big list burst the shared domain. "Enviar" now only claims
 * the campaign; EmailCampaignSender sends in the background, in batches, at
 * a pace, with retries. These tests run it against an in-memory store.
 */

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return (cond.in as unknown[]).includes(value);
      if ("not" in cond) return cond.not === null ? value !== null && value !== undefined : value !== cond.not;
      if ("lt" in cond) return value !== null && value !== undefined && value < cond.lt;
      if ("lte" in cond) return value !== null && value !== undefined && value <= cond.lte;
      if ("gt" in cond) return value !== null && value !== undefined && value > cond.gt;
      return false;
    }
    return value === cond;
  });
}

function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (v && typeof v === "object" && "decrement" in v) row[k] = (row[k] ?? 0) - v.decrement;
    else row[k] = v;
  }
  return row;
}

const NOW = new Date("2026-11-02T10:00:00Z");

function fakeDb() {
  const db = {
    campaigns: [] as Row[],
    recipients: [] as Row[],
    clients: [] as Row[],
    refusals: [] as Row[],
    // The salon's plan and clock, its month counters and its bono.
    tenant: { id: "t1", plan: "pro", subscriptionStatus: "active", trialEnd: null, maxLocations: 1, timezone: "Europe/Madrid", tenantAddOns: [] } as Row,
    usage: [] as Row[],
    wallets: [] as Row[],
    purchases: [] as Row[],
  };
  const prisma: any = {
    emailCampaign: {
      findMany: jest.fn(async ({ where, take }: any) =>
        db.campaigns
          .filter((c) => matches(c, where))
          .slice(0, take ?? Infinity)
          .map((c) => ({ ...c, tenant: { name: c.tenantName ?? "Salón Lucía", email: c.tenantEmail ?? null } })),
      ),
      findFirst: jest.fn(async ({ where }: any) => db.campaigns.find((c) => matches(c, where)) ?? null),
      findFirstOrThrow: jest.fn(async ({ where }: any) => db.campaigns.find((c) => matches(c, where))),
      update: jest.fn(async ({ where, data }: any) => apply(db.campaigns.find((c) => c.id === where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = db.campaigns.filter((c) => matches(c, where));
        hit.forEach((c) => apply(c, data));
        return { count: hit.length };
      }),
    },
    emailCampaignRecipient: {
      findMany: jest.fn(async ({ where, take }: any) =>
        db.recipients.filter((r) => matches(r, where)).slice(0, take ?? Infinity).map((r) => ({ ...r })),
      ),
      count: jest.fn(async ({ where }: any) => db.recipients.filter((r) => matches(r, where)).length),
      update: jest.fn(async ({ where, data }: any) => apply(db.recipients.find((r) => r.id === where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = db.recipients.filter((r) => matches(r, where));
        hit.forEach((r) => apply(r, data));
        return { count: hit.length };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = db.recipients.length;
        db.recipients = db.recipients.filter((r) => !matches(r, where));
        return { count: before - db.recipients.length };
      }),
    },
    client: {
      findMany: jest.fn(async ({ where }: any) => db.clients.filter((c) => matches(c, where))),
    },
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => ({ ...db.tenant, id: where.id })),
    },
    emailMarketingUsage: {
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const d of data) {
          if (db.usage.some((u) => u.tenantId === d.tenantId && u.month === d.month)) continue;
          db.usage.push({ planSent: 0, packSent: 0, ...d });
          count++;
        }
        return { count };
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        db.usage.find((u) => u.tenantId === where.tenantId_month.tenantId && u.month === where.tenantId_month.month) ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = db.usage.filter((u) => matches(u, where));
        hit.forEach((u) => apply(u, data));
        return { count: hit.length };
      }),
    },
    emailCreditWallet: {
      findUnique: jest.fn(async ({ where }: any) => db.wallets.find((w) => w.tenantId === where.tenantId) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = db.wallets.filter((w) => matches(w, where));
        hit.forEach((w) => apply(w, data));
        return { count: hit.length };
      }),
      upsert: jest.fn(({ where, create, update }: any) => async () => {
        const w = db.wallets.find((x) => x.tenantId === where.tenantId);
        if (w) apply(w, update);
        else db.wallets.push({ creditsRemaining: 0, creditsPurchasedTotal: 0, creditsUsedTotal: 0, ...create });
      }),
    },
    emailPackPurchase: {
      create: jest.fn(({ data }: any) => async () => {
        if (db.purchases.some((x) => x.stripeCheckoutSessionId === data.stripeCheckoutSessionId)) {
          const { Prisma } = jest.requireActual("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
        }
        db.purchases.push({ ...data });
      }),
    },
    // Runs the queued writes in order, as one: a failing one undoes nothing
    // here, but it runs first (the purchase row), so a repeat writes nothing.
    $transaction: jest.fn(async (ops: Array<() => Promise<unknown>>) => {
      for (const op of ops) await op();
    }),
    // Refusals of promotions, as marketing-consent reads them.
    consent: {
      findMany: jest.fn(async ({ where }: any) =>
        db.refusals
          .filter((r) => r.tenantId === where.tenantId && (!where.clientId || where.clientId.in.includes(r.clientId)))
          .map((r) => ({ clientId: r.clientId, responses: { accepts: false } })),
      ),
    },
  };
  return { db, prisma };
}

function setup(
  opts: {
    suppressed?: string[];
    send?: (to: string) => any;
    configured?: boolean;
    perMinute?: number;
    /** The bono on sale in the console (null: not priced). */
    packOffer?: { emails: number; priceCents: number } | null;
  } = {},
) {
  const { db, prisma } = fakeDb();
  db.campaigns.push({
    id: "c1",
    tenantId: "t1",
    campaignType: "newsletter",
    status: "sending",
    subject: "Ofertas de otoño",
    previewText: "Un 10 % en color",
    content: "<p>Hola</p>",
    replyTo: null,
    sentAt: null,
    archivedAt: null,
    totalRecipients: 0,
    emailsSent: 0,
    tenantName: "Salón Lucía",
    tenantEmail: "hola@salonlucia.example.test",
  });
  const recipient = (id: string, clientId: string | null, email: string, extra: Row = {}) => {
    db.recipients.push({
      id,
      campaignId: "c1",
      clientId,
      email,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      sentAt: null,
      createdAt: new Date(NOW.getTime() - 1000 * db.recipients.length),
      ...extra,
    });
    db.campaigns[0].totalRecipients++;
  };
  const client = (id: string, extra: Row = {}) =>
    db.clients.push({ id, tenantId: "t1", status: "active", lastVisit: new Date("2026-09-01"), ...extra });

  const email: any = {
    isConfigured: () => opts.configured ?? true,
    sendEmail: jest.fn(async (msg: any) =>
      opts.send ? opts.send(msg.to) : { success: true, id: `re_${msg.to}` },
    ),
  };
  const suppressions: any = {
    suppressedAmong: jest.fn(async () => new Set(opts.suppressed ?? [])),
  };
  const env: Record<string, string> = { JWT_SECRET: "test-secret", APP_BASE_URL: "https://app.test" };
  const unsubscribes = new EmailUnsubscribeService({} as any, { get: (k: string) => env[k] } as any, {} as any, {} as any);
  const pacer: any = { perMinute: opts.perMinute ?? 120, wait: jest.fn(async () => undefined) };
  const platformEmail: any = { marketingPack: () => opts.packOffer ?? null };
  const quota = new EmailQuotaService(prisma, platformEmail);
  (quota as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const sender = new EmailCampaignSender(prisma, email, suppressions, unsubscribes, pacer, quota);
  (sender as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const campaign = () => db.campaigns[0];
  const row = (id: string) => db.recipients.find((r) => r.id === id)!;
  const sendingCampaign = () => ({
    ...campaign(),
    tenant: { name: campaign().tenantName, email: campaign().tenantEmail },
  });
  return { db, prisma, email, suppressions, unsubscribes, pacer, sender, quota, campaign, row, recipient, client, sendingCampaign };
}

describe("EmailCampaignSender: a batch", () => {
  it("stores Resend's id, skips suppressed addresses and those who said no, and records failures", async () => {
    const t = setup({
      suppressed: ["rebotada@example.test"],
      send: (to) =>
        to.startsWith("fallo")
          ? { success: false, error: "Invalid `to` field", statusCode: 422, retryable: false }
          : { success: true, id: `re_${to}` },
    });
    ["k1", "k2", "k3", "k4"].forEach((id) => t.client(id));
    t.db.refusals.push({ tenantId: "t1", clientId: "k4" });
    t.recipient("r1", "k1", "ana@example.test");
    t.recipient("r2", "k2", "Rebotada@Example.test");
    t.recipient("r3", "k3", "fallo@example.test");
    t.recipient("r4", "k4", "no@example.test");

    const out = await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);

    expect(out).toMatchObject({ sent: 1, failed: 1, rateLimited: false });
    expect(t.email.sendEmail).toHaveBeenCalledTimes(2);
    expect(t.row("r1")).toMatchObject({ status: "sent", messageId: "re_ana@example.test", nextAttemptAt: null });
    expect(t.row("r2")).toMatchObject({ status: "suppressed" });
    expect(t.row("r3")).toMatchObject({ status: "failed", errorMessage: "Invalid `to` field" });
    expect(t.row("r4")).toMatchObject({ status: "unsubscribed" });
    expect(t.campaign().emailsSent).toBe(1);
  });

  it("drops, at send time, a recipient with no completed visit or no longer an active client", async () => {
    const t = setup();
    t.client("k1");
    t.client("k2", { lastVisit: null }); // never came
    t.client("k3", { status: "blocked" });
    t.recipient("r1", "k1", "ana@example.test");
    t.recipient("r2", "k2", "nueva@example.test");
    t.recipient("r3", "k3", "bloqueada@example.test");
    t.recipient("r4", null, "borrada@example.test");

    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);

    expect(t.email.sendEmail).toHaveBeenCalledTimes(1);
    expect(t.email.sendEmail.mock.calls[0][0].to).toBe("ana@example.test");
    expect(t.db.recipients.map((r) => r.id)).toEqual(["r1"]);
    expect(t.campaign().totalRecipients).toBe(1);
  });

  it("sends under the salon's name, replies to the salon, with a text part, a preheader and its unsubscribe link", async () => {
    // LSSI art. 21.2: each commercial email must offer a simple way to object.
    const t = setup();
    t.client("k1");
    t.recipient("r1", "k1", "ana@example.test");

    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);

    const msg = t.email.sendEmail.mock.calls[0][0];
    const pageUrl = "https://app.test/public/baja/" + t.unsubscribes.tokenFor({ kind: "r", id: "r1" });
    expect(msg.fromName).toBe("Salón Lucía");
    expect(msg.replyTo).toBe("hola@salonlucia.example.test");
    expect(msg.html).toContain("date de baja aquí");
    expect(msg.html).toContain(pageUrl);
    expect(msg.html).toMatch(/^<div style="display:none[^"]*">Un 10 % en color<\/div><p>Hola<\/p>/);
    expect(msg.text).toContain("Hola");
    expect(msg.text).toContain(`date de baja aquí (${pageUrl})`);
    expect(msg.text).not.toContain("Un 10 % en color");
    expect(msg.headers["List-Unsubscribe"]).toBe("<" + pageUrl + ">");
    expect(msg.idempotencyKey).toBe("email-campaign-r1");
    expect(msg.tags).toEqual([
      { name: "tenant_id", value: "t1" },
      { name: "campaign_id", value: "c1" },
    ]);
  });

  it("uses the campaign's reply-to address over the salon's", () => {
    expect(campaignSender({ replyTo: "citas@salon.example.test" }, { name: "Salón", email: "hola@salon.example.test" })).toEqual({
      fromName: "Salón",
      replyTo: "citas@salon.example.test",
    });
    expect(campaignSender({ replyTo: "  " }, { name: "Salón", email: null })).toEqual({ fromName: "Salón", replyTo: undefined });
  });

  it("never sends a literal {{discountCode}} in a one-shot campaign", async () => {
    const t = setup();
    t.campaign().content = "<p>Hola</p><p>Tu código: {{discountCode}}</p>";
    t.client("k1");
    t.recipient("r1", "k1", "ana@example.test");
    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);
    const msg = t.email.sendEmail.mock.calls[0][0];
    expect(msg.html).not.toContain("{{");
    expect(msg.html).not.toContain("Tu código");
  });

  it("puts a 5xx back in the queue with a wait, and gives up after the last try", async () => {
    const t = setup({ send: () => ({ success: false, error: "Internal server error", statusCode: 500, retryable: true }) });
    t.client("k1");
    t.recipient("r1", "k1", "ana@example.test");

    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);
    expect(t.row("r1")).toMatchObject({ status: "pending", attempts: 1 });
    expect(t.row("r1").nextAttemptAt).toEqual(new Date(NOW.getTime() + retryDelayMs(1)));

    // Not due yet: nothing is tried, and the campaign is not finished.
    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);
    expect(t.email.sendEmail).toHaveBeenCalledTimes(1);
    expect(t.campaign().status).toBe("sending");

    for (let i = 2; i <= MAX_SEND_ATTEMPTS; i++) {
      const at = new Date(t.row("r1").nextAttemptAt.getTime());
      await t.sender.sendBatch(t.sendingCampaign() as any, 100, at);
    }
    expect(t.email.sendEmail).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS);
    expect(t.row("r1")).toMatchObject({ status: "failed", attempts: MAX_SEND_ATTEMPTS, nextAttemptAt: null });
  });

  it("stops the batch on a 429: every send after it would get one too", async () => {
    const t = setup({ send: () => ({ success: false, error: "Too many requests", statusCode: 429, retryable: true }) });
    ["k1", "k2"].forEach((id) => t.client(id));
    t.recipient("r1", "k1", "ana@example.test");
    t.recipient("r2", "k2", "eva@example.test");

    const out = await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);

    expect(out.rateLimited).toBe(true);
    expect(t.email.sendEmail).toHaveBeenCalledTimes(1);
    expect(t.row("r1").status).toBe("pending");
    expect(t.row("r2")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("waits for the pacer before every email, and sends no more than the batch", async () => {
    const t = setup();
    ["k1", "k2", "k3"].forEach((id) => t.client(id));
    t.recipient("r1", "k1", "a@example.test");
    t.recipient("r2", "k2", "b@example.test");
    t.recipient("r3", "k3", "c@example.test");
    await t.sender.sendBatch(t.sendingCampaign() as any, 2, NOW);
    expect(t.pacer.wait).toHaveBeenCalledTimes(2);
    expect(t.email.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("recovers a send left in flight by a restart once its lease runs out, and finishes when nobody is left", async () => {
    const t = setup();
    t.client("k1");
    t.recipient("r1", "k1", "ana@example.test", {
      status: "sending",
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + SEND_LEASE_MS),
    });

    // Still leased: not touched, campaign not finished.
    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);
    expect(t.email.sendEmail).not.toHaveBeenCalled();
    expect(t.campaign().status).toBe("sending");

    const later = new Date(NOW.getTime() + SEND_LEASE_MS + 1000);
    await t.sender.sendBatch(t.sendingCampaign() as any, 100, later);
    expect(t.email.sendEmail).toHaveBeenCalledTimes(1);
    // Same idempotency key as the lost try: Resend does not deliver it twice.
    expect(t.email.sendEmail.mock.calls[0][0].idempotencyKey).toBe("email-campaign-r1");
    expect(t.row("r1")).toMatchObject({ status: "sent", attempts: 2 });

    await t.sender.sendBatch(t.sendingCampaign() as any, 100, later);
    expect(t.campaign()).toMatchObject({ status: "sent", sentAt: later, lastError: null });
  });

  it("finishes a campaign that reached nobody with the reason", async () => {
    const t = setup({ suppressed: ["ana@example.test"] });
    t.client("k1");
    t.recipient("r1", "k1", "ana@example.test");
    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);
    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);
    expect(t.campaign().status).toBe("sent");
    expect(t.campaign().lastError).toMatch(/No se envió a nadie/);
  });
});

describe("EmailCampaignSender: the dispatcher", () => {
  it("shares the minute's pace between the campaigns of every salon", async () => {
    const t = setup({ perMinute: 4 });
    t.db.campaigns.push({ ...t.campaign(), id: "c2", tenantId: "t2", totalRecipients: 0, emailsSent: 0 });
    for (const [i, c] of ["c1", "c1", "c1", "c1", "c2", "c2", "c2"].entries()) {
      const tenantId = c === "c1" ? "t1" : "t2";
      t.db.clients.push({ id: `k${i}`, tenantId, status: "active", lastVisit: new Date("2026-09-01") });
      t.db.recipients.push({
        id: `r${i}`,
        campaignId: c,
        clientId: `k${i}`,
        email: `x${i}@example.test`,
        status: "pending",
        attempts: 0,
        nextAttemptAt: null,
        createdAt: new Date(i),
      });
    }

    await t.sender.sendBatches(NOW);

    const tos = t.email.sendEmail.mock.calls.map((c: any[]) => c[0].to);
    expect(tos).toEqual(["x0@example.test", "x1@example.test", "x4@example.test", "x5@example.test"]);
  });

  it("starts a scheduled campaign whose time has come, and sends a scheduled one with nobody back to draft", async () => {
    const t = setup();
    t.campaign().status = "scheduled";
    t.campaign().scheduledAt = new Date(NOW.getTime() - 60_000);
    t.db.campaigns.push({ ...t.campaign(), id: "empty" });
    t.db.campaigns.push({ ...t.campaign(), id: "later", scheduledAt: new Date(NOW.getTime() + 3_600_000) });
    t.client("k1");
    t.recipient("r1", "k1", "ana@example.test");
    t.db.recipients.push({ id: "rl", campaignId: "later", clientId: "k1", email: "ana@example.test", status: "pending" });

    await t.sender.startDue(NOW);

    const byId = (id: string) => t.db.campaigns.find((c) => c.id === id)!;
    expect(byId("c1").status).toBe("sending");
    expect(byId("empty")).toMatchObject({ status: "draft", scheduledAt: null });
    expect(byId("empty").lastError).toMatch(/no tenía destinatarias/);
    expect(byId("later").status).toBe("scheduled");
  });

  it("does nothing while email sending is not configured", async () => {
    const t = setup({ configured: false });
    t.client("k1");
    t.recipient("r1", "k1", "ana@example.test");
    await t.sender.dispatch(NOW);
    expect(t.email.sendEmail).not.toHaveBeenCalled();
    expect(t.row("r1").status).toBe("pending");
  });
});

describe("EmailCampaignsService: Enviar ahora", () => {
  function service(t: ReturnType<typeof setup>) {
    const kick = jest.fn();
    const s = new EmailCampaignsService(t.prisma, t.email, t.suppressions, { kick } as any);
    return { s, kick };
  }

  it("claims the campaign and hands it to the background sender, without sending in the request", async () => {
    const t = setup();
    t.campaign().status = "draft";
    t.client("k1");
    t.recipient("r1", "k1", "ana@example.test");
    const { s, kick } = service(t);

    const result = await s.sendCampaignNow("t1", "c1");

    expect(result).toEqual({ success: true, queued: 1 });
    expect(t.campaign().status).toBe("sending");
    expect(kick).toHaveBeenCalledTimes(1);
    expect(t.email.sendEmail).not.toHaveBeenCalled();
  });

  it("refuses with nobody on the list, instead of 'sending' to 0 people", async () => {
    const t = setup();
    t.campaign().status = "draft";
    const { s, kick } = service(t);
    await expect(s.sendCampaignNow("t1", "c1")).rejects.toThrow(/no tiene destinatarias/);
    expect(t.campaign().status).toBe("draft");
    expect(kick).not.toHaveBeenCalled();
  });

  it("refuses a re-engagement campaign: it sends itself, client by client", async () => {
    const t = setup();
    Object.assign(t.campaign(), { status: "draft", campaignType: "reengagement" });
    t.recipient("r1", "k1", "ana@example.test");
    const { s } = service(t);
    await expect(s.sendCampaignNow("t1", "c1")).rejects.toThrow(/reactivación/);
    await expect(s.sendToAllClients("t1", "c1")).rejects.toThrow(/reactivación/);
    await expect(s.scheduleCampaign("t1", "c1", new Date(Date.now() + 3_600_000))).rejects.toThrow(/reactivación/);
    expect(t.campaign().status).toBe("draft");
  });

  it("cannot be sent twice: a second click finds it sending", async () => {
    const t = setup();
    t.campaign().status = "draft";
    t.client("k1");
    t.recipient("r1", "k1", "ana@example.test");
    const { s, kick } = service(t);
    await s.sendCampaignNow("t1", "c1");
    await expect(s.sendCampaignNow("t1", "c1")).rejects.toBeInstanceOf(BadRequestException);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("refuses when email is not configured, and leaves the campaign as it was", async () => {
    const t = setup({ configured: false });
    t.campaign().status = "draft";
    t.recipient("r1", "k1", "ana@example.test");
    const { s } = service(t);
    await expect(s.sendCampaignNow("t1", "c1")).rejects.toThrow(/no está configurado/);
    expect(t.campaign().status).toBe("draft");
  });

  it("Reintentar fallidos: only the failed ones go back in the queue", async () => {
    const t = setup();
    t.campaign().status = "sent";
    t.recipient("r1", "k1", "ana@example.test", { status: "sent", sentAt: NOW });
    t.recipient("r2", "k2", "eva@example.test", { status: "failed", attempts: 5, errorMessage: "Internal server error" });
    const { s, kick } = service(t);

    expect(await s.retryFailed("t1", "c1")).toEqual({ success: true, queued: 1 });
    expect(t.campaign().status).toBe("sending");
    expect(t.row("r1").status).toBe("sent");
    expect(t.row("r2")).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: null, errorMessage: null });
    expect(kick).toHaveBeenCalled();
  });

  it("Reintentar fallidos with none failed says so and leaves the campaign sent", async () => {
    const t = setup();
    t.campaign().status = "sent";
    t.recipient("r1", "k1", "ana@example.test", { status: "sent", sentAt: NOW });
    const { s } = service(t);
    await expect(s.retryFailed("t1", "c1")).rejects.toThrow(/No hay envíos fallidos/);
    expect(t.campaign().status).toBe("sent");
  });
});

describe("The monthly marketing email cap", () => {
  /** n clients with a visit, each a pending recipient of the campaign. */
  function withRecipients(t: ReturnType<typeof setup>, n: number) {
    for (let i = 1; i <= n; i++) {
      t.client(`k${i}`);
      t.recipient(`r${i}`, `k${i}`, `clienta${i}@example.test`);
    }
  }
  const usage = (t: ReturnType<typeof setup>, month: string) =>
    t.db.usage.find((u) => u.tenantId === "t1" && u.month === month);
  const byStatus = (t: ReturnType<typeof setup>, status: string) => t.db.recipients.filter((r) => r.status === status).length;

  it("counts each email sent in the salon's month, and only those sent", async () => {
    const t = setup({
      send: (to) => (to.startsWith("clienta3") ? { success: false, error: "Invalid", statusCode: 422, retryable: false } : { success: true, id: `re_${to}` }),
    });
    withRecipients(t, 3);
    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);
    // Two went out; the refused one was given back.
    expect(usage(t, "2026-11")).toMatchObject({ planSent: 2, packSent: 0 });
    const quota = await t.quota.getQuota("t1", NOW);
    expect(quota).toMatchObject({ month: "2026-11", cap: 2000, sent: 2, remaining: 1998, resetsOn: "2026-12-01" });
  });

  it("the month is the salon's: 23:30 UTC on 31 October is already November in Madrid", async () => {
    const t = setup();
    withRecipients(t, 1);
    const lateOctoberUtc = new Date("2026-10-31T23:30:00Z"); // 00:30 on 1 November in Madrid
    await t.sender.sendBatch(t.sendingCampaign() as any, 100, lateOctoberUtc);
    expect(usage(t, "2026-11")).toMatchObject({ planSent: 1 });
    expect(usage(t, "2026-10")).toBeUndefined();

    // The same instant for a salon on UTC is still October.
    t.db.tenant.timezone = "UTC";
    expect((await t.quota.getQuota("t1", lateOctoberUtc)).month).toBe("2026-10");
  });

  it("pauses the campaign at the cap with the reason, keeps the rest pending, and resumes next month", async () => {
    const t = setup();
    withRecipients(t, 3);
    t.db.usage.push({ tenantId: "t1", month: "2026-11", planSent: 1998, packSent: 0 });

    const out = await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);

    expect(out).toMatchObject({ sent: 2, capReached: true });
    expect(byStatus(t, "sent")).toBe(2);
    expect(byStatus(t, "pending")).toBe(1);
    expect(t.campaign().status).toBe("sending");
    expect(t.campaign().capPausedAt).toEqual(NOW);
    expect(t.campaign().lastError).toMatch(/En pausa: este mes ya se han enviado los 2\.000 emails de marketing de tu plan/);
    expect(t.campaign().lastError).toMatch(/1 de diciembre/);
    expect(usage(t, "2026-11")!.planSent).toBe(2000);

    // Still November: nothing resumes, nothing is sent.
    await t.sender.dispatch(new Date("2026-11-30T22:00:00Z"));
    expect(t.campaign().capPausedAt).toEqual(NOW);
    expect(byStatus(t, "pending")).toBe(1);

    // 1 December on the salon's clock (23:30 UTC on 30 November): it goes on by itself.
    const december = new Date("2026-11-30T23:30:00Z");
    await t.sender.dispatch(december);
    expect(t.campaign().capPausedAt).toBeNull();
    expect(byStatus(t, "pending")).toBe(0);
    expect(byStatus(t, "sent")).toBe(3);
    expect(usage(t, "2026-12")).toMatchObject({ planSent: 1 });
  });

  it("a bono bought resumes a paused campaign the same month, and its emails are counted apart", async () => {
    const t = setup({ packOffer: { emails: 500, priceCents: 900 } });
    withRecipients(t, 2);
    t.db.usage.push({ tenantId: "t1", month: "2026-11", planSent: 2000, packSent: 0 });

    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);
    expect(t.campaign().capPausedAt).toEqual(NOW);
    expect(t.campaign().lastError).toMatch(/o antes si compras un bono de emails/);
    expect(t.email.sendEmail).not.toHaveBeenCalled();

    // Stripe confirms the payment: the bono's emails go to the wallet, once.
    const session: any = {
      id: "cs_test_1",
      payment_status: "paid",
      client_reference_id: "t1",
      metadata: { kind: "email_pack", tenantId: "t1", emails: "500", priceCents: "900" },
    };
    expect(await creditEmailPackFromCheckout(t.prisma, session, NOW)).toBe("credited");
    expect(await creditEmailPackFromCheckout(t.prisma, session, NOW)).toBe("duplicate");
    expect(t.db.wallets[0]).toMatchObject({ creditsRemaining: 500, creditsPurchasedTotal: 500 });
    expect((await t.quota.getQuota("t1", NOW)).remaining).toBe(500);

    await t.sender.dispatch(new Date(NOW.getTime() + 60_000));
    expect(t.campaign().capPausedAt).toBeNull();
    expect(byStatus(t, "sent")).toBe(2);
    expect(usage(t, "2026-11")).toMatchObject({ planSent: 2000, packSent: 2 });
    expect(t.db.wallets[0]).toMatchObject({ creditsRemaining: 498, creditsUsedTotal: 2 });
  });

  it("an email that fails after taking a bono slot gives it back", async () => {
    const t = setup({ send: () => ({ success: false, error: "Invalid", statusCode: 422, retryable: false }) });
    withRecipients(t, 1);
    t.db.usage.push({ tenantId: "t1", month: "2026-11", planSent: 2000, packSent: 0 });
    t.db.wallets.push({ tenantId: "t1", creditsRemaining: 10, creditsPurchasedTotal: 10, creditsUsedTotal: 0 });
    await t.sender.sendBatch(t.sendingCampaign() as any, 100, NOW);
    expect(t.db.wallets[0]).toMatchObject({ creditsRemaining: 10, creditsUsedTotal: 0 });
    expect(usage(t, "2026-11")).toMatchObject({ planSent: 2000, packSent: 0 });
  });

  it("Empresa counts 5,000 per billed location", async () => {
    const t = setup();
    Object.assign(t.db.tenant, { plan: "empresa", maxLocations: 3 });
    expect((await t.quota.getQuota("t1", NOW)).cap).toBe(15000);
  });

  it("an unpaid or foreign session credits nothing", async () => {
    const t = setup();
    expect(await creditEmailPackFromCheckout(t.prisma, { id: "cs_2", payment_status: "unpaid", client_reference_id: "t1", metadata: { kind: "email_pack", tenantId: "t1", emails: "500" } } as any)).toBe("unpaid");
    expect(await creditEmailPackFromCheckout(t.prisma, { id: "cs_3", payment_status: "paid", client_reference_id: null, metadata: { kind: "email_pack", emails: "x" } } as any)).toBe("invalid");
    expect(t.db.wallets).toEqual([]);
  });
});
