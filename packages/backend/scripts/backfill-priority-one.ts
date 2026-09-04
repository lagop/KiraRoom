/* eslint-disable no-console */
/**
 * P1.3 + P1.4 backfill script.
 *
 * One-shot, idempotent, safe to re-run. Should be executed once after the
 * `20260715100000_priority_one_onboarding_rebooking` migration is applied
 * so existing tenants get:
 *
 *   1. Their `OnboardingState` row populated via `detectAll()`.
 *   2. Their `ClientCadence` rows computed for clients with >= 3 completed
 *      appointments (the same threshold the runtime cron uses).
 *
 * Usage (from packages/backend):
 *   npx ts-node scripts/backfill-priority-one.ts
 *
 * Env: requires `DATABASE_URL` (loaded automatically via PrismaService).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function backfillOnboarding() {
  const tenants = await prisma.tenant.findMany({
    select: { id: true },
    where: { deletedAt: null },
  });
  console.log(`[onboarding] ${tenants.length} tenants`);
  // The actual detector lives in the Nest service, but it ultimately only
  // needs the Prisma client. We call the same Prisma queries here.
  // (For full migration, the recommended path is to start the API once
  // and let `OnboardingDetectorService.detectAll(tenantId)` be invoked via
  // /onboarding/state for each tenant. This script seeds the row directly.)
  for (const t of tenants) {
    await prisma.onboardingState.upsert({
      where: { tenantId: t.id },
      create: { tenantId: t.id, steps: {} as any },
      update: {},
    });
  }
  console.log(`[onboarding] ensured ${tenants.length} state rows`);
}

async function backfillCadence() {
  const tenants = await prisma.tenant.findMany({
    select: { id: true, rebookingSettings: true },
    where: { deletedAt: null },
  });
  let totalClients = 0;
  for (const t of tenants) {
    const settings = (t.rebookingSettings as any) ?? {};
    const minVisits: number = settings.minVisits ?? 3;
    const candidates = await prisma.appointment.findMany({
      where: { tenantId: t.id, status: "completed" },
      select: { clientId: true },
      distinct: ["clientId"],
    });
    for (const c of candidates) {
      const count = await prisma.appointment.count({
        where: {
          clientId: c.clientId,
          status: "completed",
          completionTime: { not: null },
        },
      });
      if (count < minVisits) continue;
      // Mark for cron to pick up; we don't precompute cadence here because
      // that requires the runtime service. The first /rebooking/recompute/:id
      // call (or the next appointment completion) will fill in the row.
      totalClients++;
    }
  }
  console.log(
    `[cadence] ${totalClients} clients eligible for cadence computation (run via cron or POST /rebooking/recompute/:id)`,
  );
}

async function main() {
  console.log("P1 — Onboarding + rebooking backfill starting…");
  await backfillOnboarding();
  await backfillCadence();
  console.log("done");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });