import { ForbiddenException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { normalizePlan, PLAN_LABELS_ES, PLAN_MAX_PROFESSIONALS, type PlanId } from "@kira/shared";
import type { PrismaService } from "../common/prisma/prisma.service";

/** What the check reads: the salon's plan and its active professionals. */
type SlotReader = Pick<Prisma.TransactionClient, "tenant" | "professional">;

/**
 * The plan's cap on active professionals (Esencial 4, Pro 10, Empresa
 * none), checked before one is added or reactivated. It was only shown on
 * the billing page, so any salon could add as many as it liked.
 *
 * The trial counts as Pro, like everywhere else. Inactive professionals do
 * not count, so a salon over the cap after a downgrade keeps its team and
 * can swap people, but not add more.
 *
 * On its own this is a check, not a guarantee: two adds at the same moment
 * both count N-1 and both go ahead. Writes go through withProfessionalSlot,
 * which holds the salon's lock between the count and the write.
 */
export async function assertProfessionalSlot(prisma: SlotReader, tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, subscriptionStatus: true, trialEnd: true },
  });
  if (!tenant) return;
  const inTrial =
    tenant.subscriptionStatus === "trialing" && !!tenant.trialEnd && tenant.trialEnd.getTime() > Date.now();
  const plan: PlanId = inTrial ? "pro" : normalizePlan(tenant.plan);
  const limit = PLAN_MAX_PROFESSIONALS[plan];
  if (limit === null) return;

  const active = await prisma.professional.count({ where: { tenantId, isActive: true } });
  if (active >= limit) {
    throw new ForbiddenException({
      code: "PROFESSIONAL_LIMIT_REACHED",
      message: `Tu plan ${PLAN_LABELS_ES[plan]} permite hasta ${limit} profesionales activos. Desactiva a alguien o cambia de plan para añadir más.`,
      limit,
      upgradeUrl: "/dashboard/billing",
    });
  }
}

/**
 * Adds (or reactivates) a professional within the plan's cap: in one
 * transaction, takes the salon's advisory lock (as bookings do, see
 * appointments.service), counts, and only then writes. A second add at the
 * same moment waits for the first to commit and then counts it.
 */
export async function withProfessionalSlot<T>(
  prisma: PrismaService,
  tenantId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`professional-slot:${tenantId}`}))`;
    await assertProfessionalSlot(tx, tenantId);
    return write(tx);
  });
}
