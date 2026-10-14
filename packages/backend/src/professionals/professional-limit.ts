import { ForbiddenException } from "@nestjs/common";
import { normalizePlan, PLAN_LABELS_ES, PLAN_MAX_PROFESSIONALS, type PlanId } from "@kira/shared";
import type { PrismaService } from "../common/prisma/prisma.service";

/**
 * The plan's cap on active professionals (Esencial 4, Pro 10, Empresa
 * none), checked before one is added or reactivated. It was only shown on
 * the billing page, so any salon could add as many as it liked.
 *
 * The trial counts as Pro, like everywhere else. Inactive professionals do
 * not count, so a salon over the cap after a downgrade keeps its team and
 * can swap people, but not add more.
 */
export async function assertProfessionalSlot(prisma: PrismaService, tenantId: string): Promise<void> {
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
