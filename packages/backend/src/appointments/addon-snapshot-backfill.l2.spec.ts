import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { normalizeAddons } from "./visit-totals";
import { bookedAddon } from "./appointment-snapshot";

/**
 * L2: the add-on backfill (migration 20261102050000_appointment_addon_snapshot)
 * against a real database.
 *
 * Appointments booked before the snapshot keep add-on lines without a price,
 * so they read today's catalog. The migration fills, from the current
 * catalog, the lines of the appointments that can still change -- upcoming,
 * or not paid -- and leaves history, cancelled and no-show visits alone; a
 * line with a price keeps it; a line naming no service of the same salon is
 * left as it is. Running it again changes nothing.
 *
 * The migration is one DO block, run here as the deploy runs it. Skipped when
 * no database is reachable, so `npm test` stays green on a workstation
 * without Postgres. CI provides one.
 */
const prisma = new PrismaClient();
const db: any = prisma;
let reachable = false;
const run = randomUUID().slice(0, 8);
const tenantIds: string[] = [];
let tenantId: string;
let otherTenantId: string;
let clientId: string;
let professionalId: string;
let mainId: string;
let maskId: string;
let glossId: string;
let foreignId: string;

const MIGRATION = readFileSync(
  join(__dirname, "../../prisma/migrations/20261102050000_appointment_addon_snapshot/migration.sql"),
  "utf8",
);
const backfill = () => prisma.$executeRawUnsafe(MIGRATION);

const DAY = 86_400_000;
const today = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");

async function appointment(addons: unknown, over: Record<string, unknown> = {}) {
  const row = await db.appointment.create({
    data: {
      tenantId,
      clientId,
      professionalId,
      serviceId: mainId,
      scheduledDate: new Date(today().getTime() + 3 * DAY),
      scheduledTime: "10:00",
      duration: 30,
      endTime: "10:30",
      price: 20,
      addons,
      ...over,
    },
  });
  return row.id as string;
}
const addonsOf = async (id: string) => (await db.appointment.findUnique({ where: { id }, select: { addons: true } })).addons;

beforeAll(async () => {
  try {
    await prisma.$connect();
    reachable = true;
  } catch (e) {
    console.error("[l2] database unreachable, skipping:", (e as Error).message.slice(0, 160));
    return;
  }
  for (const name of ["a", "b"]) {
    const t = await db.tenant.create({
      data: {
        name: `L2 addons ${name} ${run}`,
        slug: `l2-addons-${name}-${run}`,
        plan: "pro",
        subscriptionStatus: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + DAY),
      },
    });
    tenantIds.push(t.id);
  }
  [tenantId, otherTenantId] = tenantIds;
  clientId = (await db.client.create({ data: { tenantId, firstName: "Marta", lastName: "Extras", phone: "600000001" } })).id;
  professionalId = (
    await db.professional.create({ data: { tenantId, firstName: "Ana", lastName: "Pérez", email: `l2-addons-${run}@example.test`, hireDate: new Date() } })
  ).id;
  const service = (data: Record<string, unknown>, tenant = tenantId) =>
    db.service.create({ data: { tenantId: tenant, isActive: true, category: "hair", ...data } }).then((s: any) => s.id as string);
  mainId = await service({ name: "Corte", price: 20, duration: 30 });
  maskId = await service({ name: "Mascarilla", price: 8.5, duration: 15 });
  glossId = await service({ name: "Brillo", price: 3, duration: 5 });
  foreignId = await service({ name: "De otro salón", price: 99, duration: 60 }, otherTenantId);
}, 60_000);

afterAll(async () => {
  if (reachable && tenantIds.length) {
    await db.appointment.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await db.service.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await db.professional.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await db.client.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe("add-on snapshot backfill", () => {
  it("fills the open visits' add-ons from the catalog, leaves history and kept prices alone, and is idempotent", async () => {
    if (!reachable) return;

    const upcoming = await appointment([{ addonId: maskId, quantity: 2 }]);
    // One line already has what it was added at: it keeps it.
    const mixed = await appointment([
      { addonId: glossId, quantity: 1, name: "Brillo (antes)", price: 2.5, duration: 4 },
      { addonId: maskId, quantity: 1 },
    ]);
    // In the past but not paid: can still change.
    const unpaid = await appointment([{ addonId: maskId, quantity: 1 }], {
      scheduledDate: new Date(today().getTime() - 30 * DAY),
      paymentStatus: "pending",
    });
    // History: paid and in the past.
    const history = await appointment([{ addonId: maskId, quantity: 1 }], {
      scheduledDate: new Date(today().getTime() - 30 * DAY),
      paymentStatus: "paid",
      status: "completed",
    });
    const cancelled = await appointment([{ addonId: maskId, quantity: 1 }], { status: "cancelled" });
    const noShow = await appointment([{ addonId: maskId, quantity: 1 }], { status: "no_show" });
    // The older stored shapes the reader still accepts.
    const setShape = await appointment({ set: [{ serviceId: glossId, quantity: 3 }] });
    const mapShape = await appointment({ [maskId]: 2 });
    // Lines that name no service of this salon: another salon's, a deleted one.
    const strangers = await appointment([
      { addonId: foreignId, quantity: 1 },
      { addonId: randomUUID(), quantity: 1 },
      { addonId: glossId, quantity: 1 },
    ]);
    const none = await appointment([]);

    await backfill();

    expect(await addonsOf(upcoming)).toEqual([
      { addonId: maskId, quantity: 2, name: "Mascarilla", price: 8.5, duration: 15 },
    ]);
    expect(await addonsOf(mixed)).toEqual([
      { addonId: glossId, quantity: 1, name: "Brillo (antes)", price: 2.5, duration: 4 },
      { addonId: maskId, quantity: 1, name: "Mascarilla", price: 8.5, duration: 15 },
    ]);
    expect(await addonsOf(unpaid)).toEqual([{ addonId: maskId, quantity: 1, name: "Mascarilla", price: 8.5, duration: 15 }]);
    for (const untouched of [history, cancelled, noShow]) {
      expect(await addonsOf(untouched)).toEqual([{ addonId: maskId, quantity: 1 }]);
    }
    expect(await addonsOf(setShape)).toEqual([{ serviceId: glossId, quantity: 3, name: "Brillo", price: 3, duration: 5 }]);
    expect(await addonsOf(mapShape)).toEqual([{ addonId: maskId, quantity: 2, name: "Mascarilla", price: 8.5, duration: 15 }]);
    const mixedStrangers = (await addonsOf(strangers)) as any[];
    expect(mixedStrangers[0]).toEqual({ addonId: foreignId, quantity: 1 });
    expect(mixedStrangers[1]).not.toHaveProperty("price");
    expect(mixedStrangers[2]).toEqual({ addonId: glossId, quantity: 1, name: "Brillo", price: 3, duration: 5 });
    expect(await addonsOf(none)).toEqual([]);

    // The readers now take the booked price, not today's catalog.
    await db.service.update({ where: { id: maskId }, data: { price: 12, duration: 20 } });
    const [line] = normalizeAddons(await addonsOf(upcoming));
    expect(bookedAddon(line, { id: maskId, name: "Mascarilla", price: 12, duration: 20 })).toMatchObject({ price: 8.5, duration: 15 });

    // Again: nothing changes (a line with a price is never re-priced).
    const before = await db.appointment.findMany({ where: { tenantId }, select: { id: true, addons: true }, orderBy: { id: "asc" } });
    await backfill();
    const after = await db.appointment.findMany({ where: { tenantId }, select: { id: true, addons: true }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);
  }, 60_000);
});
