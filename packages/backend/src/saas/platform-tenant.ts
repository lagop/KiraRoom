import { BadRequestException } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";

/**
 * The "Platform" tenant (audit 8, C14): the account the platform owner
 * (saas_owner) belongs to, created by scripts/seed-saas-owner.ts. It is not a
 * salon. It used to appear in the console's salon list with the buttons to
 * enter, edit and delete it, and anonymising it would have rewritten the
 * platform owner's own email and switched the account off.
 *
 * It is recognised by the seed's slug or by having a saas_owner in it, so a
 * renamed one is still caught.
 */
export const PLATFORM_TENANT_SLUG = "platform";

export const PLATFORM_TENANT_WHERE: Prisma.TenantWhereInput = {
  OR: [{ slug: PLATFORM_TENANT_SLUG }, { users: { some: { role: UserRole.saas_owner } } }],
};

/** Spread into a salon list's where: everything but the Platform tenant. */
export const NOT_PLATFORM_TENANT_WHERE: Prisma.TenantWhereInput = { NOT: PLATFORM_TENANT_WHERE };

export const PLATFORM_TENANT_PROTECTED_MESSAGE =
  "«Platform» es la cuenta de la plataforma, no un salón: no se puede borrar, suspender, anonimizar ni abrir como soporte.";

type TenantCounter = { tenant: { count(args: { where: Prisma.TenantWhereInput }): Promise<number> } };

export async function isPlatformTenant(prisma: TenantCounter, tenantId: string): Promise<boolean> {
  const n = await prisma.tenant.count({ where: { AND: [{ id: tenantId }, PLATFORM_TENANT_WHERE] } });
  return n > 0;
}

/** Refuses an action meant for salons on the Platform tenant. */
export async function assertNotPlatformTenant(prisma: TenantCounter, tenantId: string): Promise<void> {
  if (await isPlatformTenant(prisma, tenantId)) {
    throw new BadRequestException(PLATFORM_TENANT_PROTECTED_MESSAGE);
  }
}
