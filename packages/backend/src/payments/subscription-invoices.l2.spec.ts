import { PrismaClient } from "@prisma/client";

/**
 * L2: the console's copy of plan invoices, against a real database. One row per
 * Stripe invoice, and the row outlives the salon (it is KiraRoom's own record).
 * Skipped when no database is reachable; CI provides one.
 */
const prisma = new PrismaClient();
let reachable = false;
const db = prisma as any;

const tenantData = (slug: string) => ({
  name: "L2 invoices",
  slug,
  plan: "esencial" as const,
  subscriptionStatus: "active" as const,
  currentPeriodStart: new Date(),
  currentPeriodEnd: new Date(Date.now() + 864e5),
});

const invoiceData = (tenantId: string | null, stripeInvoiceId: string) => ({
  stripeInvoiceId,
  tenantId,
  tenantName: "L2 invoices",
  stripeCustomerId: "cus_l2",
  livemode: false,
  status: "paid",
  currency: "EUR",
  amountDueCents: 4900,
  amountPaidCents: 4900,
  invoiceCreatedAt: new Date(),
});

beforeAll(async () => {
  try {
    await prisma.$connect();
    reachable = true;
    await db.subscriptionInvoice.deleteMany({ where: { stripeInvoiceId: { startsWith: "in_l2_" } } });
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: "l2-invoices-" } } });
  } catch (e) {
    console.error("[l2] database unreachable, skipping:", (e as Error).message.slice(0, 160));
  }
}, 30000);

afterAll(async () => {
  if (reachable) {
    await db.subscriptionInvoice.deleteMany({ where: { stripeInvoiceId: { startsWith: "in_l2_" } } });
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: "l2-invoices-" } } });
  }
  await prisma.$disconnect();
});

const dbTest = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });

describe("subscription_invoices", () => {
  dbTest("one row per Stripe invoice", async () => {
    const tenant = await prisma.tenant.create({ data: tenantData("l2-invoices-a") });
    await db.subscriptionInvoice.create({ data: invoiceData(tenant.id, "in_l2_1") });
    await expect(db.subscriptionInvoice.create({ data: invoiceData(tenant.id, "in_l2_1") })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  dbTest("the invoice stays, without a salon, when the salon is deleted", async () => {
    const tenant = await prisma.tenant.create({ data: tenantData("l2-invoices-b") });
    await db.subscriptionInvoice.create({ data: invoiceData(tenant.id, "in_l2_2") });
    await prisma.tenant.delete({ where: { id: tenant.id } });
    const row = await db.subscriptionInvoice.findUnique({ where: { stripeInvoiceId: "in_l2_2" } });
    expect(row).toMatchObject({ tenantId: null, tenantName: "L2 invoices", amountPaidCents: 4900 });
  });
});
