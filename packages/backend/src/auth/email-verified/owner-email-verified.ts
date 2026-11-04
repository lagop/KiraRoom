import type { Prisma } from "@prisma/client";

/**
 * D1 (owner's decision, 2026-11-04): until the salon owner confirms their
 * email, the salon cannot send email campaigns or mass SMS / WhatsApp, cannot
 * connect its own Stripe account, and its web page is left out of the sitemap
 * and marked noindex. Everything else works.
 *
 * "Confirmed" is per salon: any owner of the tenant with a confirmed email
 * (an owner who joined by invitation confirmed it by opening the invite).
 * Salons created before this rule were marked confirmed by the migration
 * 20261104141000_existing_owners_email_verified.
 */
export const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED";

export const EMAIL_NOT_VERIFIED_MESSAGE =
  "Confirma el email de la cuenta para hacer esto: te enviamos un enlace al crearla. " +
  "Puedes pedir otro desde el aviso de arriba del panel.";

/** Prisma filter: the tenant has an owner with a confirmed email. */
export const TENANT_OWNER_EMAIL_VERIFIED: Prisma.TenantWhereInput = {
  users: { some: { role: "owner", isEmailVerified: true } },
};

/** Whether the tenant has an owner with a confirmed email. */
export async function tenantOwnerEmailVerified(
  prisma: { user: { count: (args: { where: Prisma.UserWhereInput }) => Promise<number> } },
  tenantId: string,
): Promise<boolean> {
  const count = await prisma.user.count({
    where: { tenantId, role: "owner", isEmailVerified: true },
  });
  return count > 0;
}
