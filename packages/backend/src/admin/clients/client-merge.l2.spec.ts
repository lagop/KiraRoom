import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { AuditLogService } from "../../saas/audit-log.service";
import { CLIENT_REFERENCES, ClientMergeService } from "./client-merge.service";

/**
 * L2: merging two clients against a real database.
 *
 * The source record is given a row in every table that can point at a
 * client (and the target a clashing row where a table allows one per
 * client), then merged. Afterwards nothing points at the source (checked
 * for every entry of CLIENT_REFERENCES, which client-merge.service.spec.ts
 * keeps in step with the schema), the rows are the target's, and the
 * totals add up.
 *
 * Skipped when no database is reachable, so `npm test` stays green on a
 * workstation without Postgres. CI provides one.
 */
const prisma = new PrismaClient();
const db: any = prisma;
let reachable = false;

const run = randomUUID().slice(0, 8);
let tenantId: string;
let actorId: string;
let T: string; // target
let S: string; // source
let result: any;

const delegate = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

beforeAll(async () => {
  try {
    await prisma.$connect();
    reachable = true;
  } catch (e) {
    console.error("[l2] database unreachable, skipping:", (e as Error).message.slice(0, 160));
    return;
  }

  const tenant = await db.tenant.create({
    data: {
      name: "L2 merge",
      slug: `l2-merge-${run}`,
      plan: "esencial",
      subscriptionStatus: "trialing",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
    },
  });
  tenantId = tenant.id;
  const owner = await db.user.create({
    data: { tenantId, email: `l2-merge-${run}@example.test`, firstName: "O", lastName: "W", role: "owner", passwordHash: "x" },
  });
  actorId = owner.id;
  const service = await db.service.create({ data: { tenantId, name: "Corte", category: "hair", duration: 30, price: 20 } });
  const pro = await db.professional.create({
    data: { tenantId, firstName: "P", lastName: "R", email: `pro-${run}@example.test`, hireDate: new Date() },
  });

  const target = await db.client.create({
    data: {
      tenantId,
      firstName: "Ana",
      lastName: "López",
      phone: "+34600111222",
      notes: "Rubio",
      tags: ["vip"],
      allergies: [],
      communicationPreferences: { whatsapp: true },
      totalSpent: 100,
      visitCount: 2,
      loyaltyPoints: 50,
      loyaltyTier: "silver",
      firstVisit: new Date("2025-03-01"),
      lastVisit: new Date("2026-01-01"),
    },
  });
  const source = await db.client.create({
    data: {
      tenantId,
      firstName: "Ana",
      lastName: "Lopez",
      email: "Ana@Mail.test",
      phone: "+34611222333",
      taxId: "12345678Z",
      taxIdType: "nif",
      passwordHash: "source-hash",
      notes: "Alérgica al tinte",
      tags: ["vip", "nueva"],
      allergies: ["tinte"],
      communicationPreferences: { whatsapp: false },
      totalSpent: 50,
      visitCount: 1,
      loyaltyPoints: 30,
      loyaltyTier: "bronze",
      firstVisit: new Date("2024-06-01"),
      lastVisit: new Date("2026-05-01"),
    },
  });
  T = target.id;
  S = source.id;

  // History.
  const appt = await db.appointment.create({
    data: {
      tenantId, clientId: S, serviceId: service.id, professionalId: pro.id,
      scheduledDate: new Date("2026-05-01"), scheduledTime: "10:00", duration: 30, endTime: "10:30", price: 20,
    },
  });
  await db.payment.create({ data: { tenantId, clientId: S, appointmentId: appt.id, amount: 2000, type: "appointment" } });
  await db.order.create({ data: { tenantId, clientId: S, orderNumber: `L2-${run}` } });
  await db.chatConversation.create({ data: { tenantId, clientId: S } });
  await db.notification.create({ data: { tenantId, clientId: S, type: "appointment_created", title: "t", message: "m" } });
  await db.rebookingReminder.create({ data: { tenantId, clientId: S, scheduledAt: new Date(), channel: "email", status: "scheduled" } });
  await db.waitList.create({ data: { tenantId, clientId: S, serviceId: service.id } });
  await db.review.create({ data: { tenantId, clientId: S, rating: 5 } });
  await db.promotionUsage.create({ data: { promotionId: randomUUID(), clientId: S, discountAmount: 5 } });
  await db.invoice.create({
    data: {
      tenantId, series: "L2", number: run, issueDate: new Date(), recipientType: "client", recipientId: S,
      recipientName: "Ana Lopez", subtotalCents: 1653, taxBreakdown: [], totalCents: 2000, sourceType: "appointment",
    },
  });
  await db.giftCard.create({
    data: { tenantId, code: `L2-${run}`, initialAmount: 5000, currentBalance: 5000, purchasedById: S, recipientId: S },
  });
  await db.authSession.create({
    data: { subjectId: S, subjectType: "client", currentJti: randomUUID(), expiresAt: new Date(Date.now() + 864e5) },
  });

  // Consents: a treatment form, and opposite marketing choices.
  const treatment = await db.consentForm.create({ data: { tenantId, name: "Tinte", fields: [] } });
  const marketing = await db.consentForm.create({ data: { tenantId, name: "Comunicaciones comerciales", fields: [], purpose: "marketing" } });
  const consent = (clientId: string, formId: string, responses: any, signedAt: Date) =>
    db.consent.create({
      data: {
        tenantId, clientId, formId, formVersion: 1, formSnapshot: [], responses,
        signatureName: "Ana", signatureIpHash: "h", signedAt,
      },
    });
  await consent(S, treatment.id, {}, new Date("2026-04-01"));
  await consent(T, marketing.id, { accepts: false }, new Date("2026-01-01"));
  await consent(S, marketing.id, { accepts: true }, new Date("2026-06-01"));

  // Campaigns: the first has both records, the second only the source.
  const both = await db.emailCampaign.create({
    data: { tenantId, name: "A", subject: "s", content: "c", campaignType: "newsletter", totalRecipients: 2 },
  });
  const onlySource = await db.emailCampaign.create({
    data: { tenantId, name: "B", subject: "s", content: "c", campaignType: "newsletter", totalRecipients: 1 },
  });
  await db.emailCampaignRecipient.create({ data: { campaignId: both.id, clientId: T, email: "t@x.test" } });
  await db.emailCampaignRecipient.create({ data: { campaignId: both.id, clientId: S, email: "s@x.test" } });
  await db.emailCampaignRecipient.create({ data: { campaignId: onlySource.id, clientId: S, email: "s@x.test" } });
  const wa = await db.whatsAppCampaign.create({ data: { tenantId, name: "W", templateId: "tpl", totalRecipients: 1 } });
  await db.whatsAppCampaignRecipient.create({ data: { campaignId: wa.id, clientId: S, phone: "+34611222333" } });

  // One-per-client rows, on both sides.
  const tw = await db.clientWallet.create({ data: { tenantId, clientId: T, balance: 1000 } });
  const sw = await db.clientWallet.create({ data: { tenantId, clientId: S, balance: 500 } });
  await db.walletTransaction.create({ data: { walletId: tw.id, type: "credit", amount: 1000, balanceAfter: 1000 } });
  await db.walletTransaction.create({ data: { walletId: sw.id, type: "credit", amount: 500, balanceAfter: 500 } });

  const program = await db.loyaltyProgram.create({ data: { tenantId } });
  await db.loyaltyTier.create({ data: { programId: program.id, name: "Silver", minPoints: 0 } });
  const gold = await db.loyaltyTier.create({ data: { programId: program.id, name: "Gold", minPoints: 300 } });
  const tm = await db.loyaltyMember.create({ data: { clientId: T, programId: program.id, lifetimePoints: 100, currentPoints: 50 } });
  const sm = await db.loyaltyMember.create({ data: { clientId: S, programId: program.id, lifetimePoints: 250, currentPoints: 30 } });
  const ledger = (memberId: string, sourceId: string, points: number) =>
    db.loyaltyTransaction.create({
      data: { tenantId, programId: program.id, memberId, type: "earn", points, source: "appointment", sourceId },
    });
  await ledger(tm.id, "same-event", 10);
  await ledger(sm.id, "same-event", 10); // clashes with the target's
  await ledger(sm.id, appt.id, 20);
  (globalThis as any).__l2merge = { gold: gold.id, both: both.id, onlySource: onlySource.id, tw: tw.id };

  await db.clientProfile.create({ data: { tenantId, clientId: T, name: "Ana", interactionHistory: ["t1"] } });
  await db.clientProfile.create({ data: { tenantId, clientId: S, name: "Ana", interactionHistory: ["s1"] } });
  await db.notificationPreference.create({ data: { tenantId, clientId: S, preferences: { reminder: { sms: false } } } });
  await db.clientCadence.create({ data: { tenantId, clientId: T, reminderSentFor: [{ serviceId: "a" }] } });
  await db.clientCadence.create({ data: { tenantId, clientId: S, reminderSentFor: [{ serviceId: "b" }], optedOut: true } });

  const merger = new ClientMergeService(prisma as any, new AuditLogService(prisma as any));
  result = await merger.merge(tenantId, T, S, { id: actorId, role: "owner" as any });
}, 60000);

afterAll(async () => {
  if (reachable && tenantId) {
    await db.payment.deleteMany({ where: { tenantId } });
    await db.appointment.deleteMany({ where: { tenantId } });
    await db.consent.deleteMany({ where: { tenantId } });
    await db.auditLog.deleteMany({ where: { tenantId } });
    await db.promotionUsage.deleteMany({ where: { clientId: { in: [T, S] } } });
    await db.authSession.deleteMany({ where: { subjectId: { in: [T, S] } } });
    await db.tenant.delete({ where: { id: tenantId } });
  }
  await prisma.$disconnect();
});

const itDb = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });

describe("merging two clients (L2)", () => {
  itDb("leaves nothing pointing at the source, and deletes it", async () => {
    for (const ref of Object.keys(CLIENT_REFERENCES)) {
      const [model, field] = ref.split(".");
      const where: any = { [field]: S };
      if (model === "AuthSession") where.revokedAt = null;
      expect([ref, await db[delegate(model)].count({ where })]).toEqual([ref, 0]);
    }
    expect(await db.client.findUnique({ where: { id: S } })).toBeNull();
    expect(await db.authSession.count({ where: { subjectId: S } })).toBe(1); // revoked, kept
  });

  itDb("moves the history to the target", async () => {
    for (const model of [
      "appointment", "payment", "order", "chatConversation", "notification", "rebookingReminder",
      "waitList", "review", "promotionUsage", "notificationPreference",
    ]) {
      expect([model, await db[model].count({ where: { clientId: T } })]).toEqual([model, 1]);
    }
    expect(await db.invoice.count({ where: { tenantId, recipientId: T } })).toBe(1);
    expect(await db.giftCard.count({ where: { tenantId, purchasedById: T, recipientId: T } })).toBe(1);
    expect(result.moved).toMatchObject({ appointments: 1, payments: 1, orders: 1, invoices: 1, consents: 2 });
    expect(result.message).toBe(
      "Fichas fusionadas. Ahora están en la ficha de Ana López: 1 cita, 1 pago, 1 venta, 1 factura, 2 consentimientos, 1 reseña.",
    );
  });

  itDb("puts her on each campaign once", async () => {
    const { both, onlySource } = (globalThis as any).__l2merge;
    expect(await db.emailCampaignRecipient.count({ where: { campaignId: both, clientId: T } })).toBe(1);
    expect(await db.emailCampaignRecipient.count({ where: { campaignId: both } })).toBe(1);
    expect((await db.emailCampaign.findUnique({ where: { id: both } })).totalRecipients).toBe(1);
    expect(await db.emailCampaignRecipient.count({ where: { campaignId: onlySource, clientId: T } })).toBe(1);
    expect(await db.whatsAppCampaignRecipient.count({ where: { clientId: T } })).toBe(1);
  });

  itDb("adds up the wallet and the loyalty points, keeping their history", async () => {
    const { gold, tw } = (globalThis as any).__l2merge;
    const wallets = await db.clientWallet.findMany({ where: { clientId: T } });
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ id: tw, balance: 1500 });
    const lines = await db.walletTransaction.findMany({ where: { walletId: tw }, orderBy: { createdAt: "asc" } });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ type: "credit", amount: 500, balanceAfter: 1500, referenceType: "client_merge" });

    const members = await db.loyaltyMember.findMany({ where: { clientId: T } });
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ lifetimePoints: 350, currentPoints: 80, tierId: gold });
    expect(await db.loyaltyTransaction.count({ where: { memberId: members[0].id } })).toBe(3);
  });

  itDb("keeps one profile, one cadence and one marketing choice: the refusal", async () => {
    const profiles = await db.clientProfile.findMany({ where: { clientId: T } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].interactionHistory).toEqual(["t1", "s1"]);

    const cadence = await db.clientCadence.findUnique({ where: { clientId: T } });
    expect(cadence.reminderSentFor).toEqual([{ serviceId: "a" }, { serviceId: "b" }]);
    expect(cadence.optedOut).toBe(true);

    const active = await db.consent.findMany({ where: { clientId: T, revokedAt: null, form: { purpose: "marketing" } } });
    expect(active).toHaveLength(1);
    expect(active[0].responses).toEqual({ accepts: false });
    const revoked = await db.consent.findMany({ where: { clientId: T, revokeReason: "superseded_by_merge" } });
    expect(revoked).toHaveLength(1);
  });

  itDb("fills the target's empty fields and joins the rest", async () => {
    const c = await db.client.findUnique({ where: { id: T } });
    expect(c).toMatchObject({
      firstName: "Ana",
      lastName: "López",
      email: "ana@mail.test",
      phone: "+34600111222",
      taxId: "12345678Z",
      taxIdType: "nif",
      // Her account came with her sign-in address.
      passwordHash: "source-hash",
      notes: "Rubio\n\nAlérgica al tinte",
      tags: ["vip", "nueva"],
      allergies: ["tinte"],
      communicationPreferences: { whatsapp: false },
      visitCount: 3,
      loyaltyPoints: 80,
      loyaltyTier: "silver",
    });
    expect(Number(c.totalSpent)).toBe(150);
    expect(Number(c.averageSpent)).toBe(50);
    expect(c.firstVisit.toISOString().slice(0, 10)).toBe("2024-06-01");
    expect(c.lastVisit.toISOString().slice(0, 10)).toBe("2026-05-01");
  });

  itDb("records who merged what in the audit log", async () => {
    const rows = await db.auditLog.findMany({ where: { tenantId, action: "client.merge" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId, actorRole: "owner" });
    expect(rows[0].metadata).toMatchObject({ targetClientId: T, sourceClientId: S });
  });
});
