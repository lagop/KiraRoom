import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { AuditLogService } from "../saas/audit-log.service";
import {
  normalizeWebAddress,
  redirectExpiry,
  WEB_ADDRESS_MESSAGES,
  webAddressShapeProblem,
  type WebAddressProblem,
} from "./web-address-rules";

export interface WebAddressAvailability {
  slug: string;
  available: boolean;
  problem: WebAddressProblem | null;
  message: string | null;
}

export const WEB_ADDRESS_ALREADY_CHANGED =
  "La dirección web solo se puede cambiar una vez y ya la cambiaste. Si necesitas otra, escríbenos.";

type RedirectLookup = { tenantSlugRedirect?: { findFirst: (args: any) => Promise<unknown> } };
type SlugLookupClient = RedirectLookup & { tenant: { findUnique: (args: any) => Promise<unknown> } };

/** The salon an old address still redirects to, or null (none, or past its 12 months). */
export async function redirectedTenantId(prisma: RedirectLookup, slug: string, now: Date = new Date()): Promise<string | null> {
  if (!prisma.tenantSlugRedirect || !slug) return null;
  const row = (await prisma.tenantSlugRedirect.findFirst({
    where: { oldSlug: slug, expiresAt: { gt: now } },
    select: { tenantId: true },
  })) as { tenantId: string } | null;
  return row?.tenantId ?? null;
}

/**
 * Whether `slug` is held by a salon: as its address, or as an old address
 * still redirecting (an expired one does not count). `exceptTenantId` is the
 * salon asking: its own current address is not "taken" for it.
 */
export async function webAddressTaken(prisma: SlugLookupClient, slug: string, exceptTenantId?: string): Promise<boolean> {
  const tenant = (await prisma.tenant.findUnique({ where: { slug }, select: { id: true } })) as { id: string } | null;
  if (tenant && tenant.id !== exceptTenantId) return true;
  return (await redirectedTenantId(prisma, slug)) !== null;
}

@Injectable()
export class WebAddressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** For the signup form and Ajustes > Web: can this address be used? */
  async availability(input: string, exceptTenantId?: string): Promise<WebAddressAvailability> {
    const slug = normalizeWebAddress(input);
    const shape = webAddressShapeProblem(slug);
    const problem: WebAddressProblem | null =
      shape ?? ((await webAddressTaken(this.prisma, slug, exceptTenantId)) ? "taken" : null);
    return { slug, available: problem === null, problem, message: problem ? WEB_ADDRESS_MESSAGES[problem] : null };
  }

  /** Ajustes > Web: the address, whether it can still be changed, and the old one while it redirects. */
  async current(tenantId: string, now: Date = new Date()) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        slug: true,
        slugChangedAt: true,
        slugRedirects: { where: { expiresAt: { gt: now } }, select: { oldSlug: true, expiresAt: true } },
      },
    });
    if (!tenant) throw new NotFoundException("Salon not found");
    return {
      slug: tenant.slug,
      canChange: tenant.slugChangedAt === null,
      changedAt: tenant.slugChangedAt,
      redirects: tenant.slugRedirects,
    };
  }

  /**
   * The once-only change. The old address goes to tenant_slug_redirects for
   * 12 months. An expired row holding the new address (another salon's old
   * one, past its 12 months) is deleted first, so the address is free again.
   */
  async change(
    tenantId: string,
    actor: { id: string; role: string; impersonatedBy?: string },
    input: string,
    now: Date = new Date(),
  ) {
    if (actor.role !== "owner") throw new ForbiddenException("Solo la dueña del salón puede cambiar la dirección web.");
    if (actor.impersonatedBy) {
      throw new ForbiddenException("La dirección web la cambia la dueña del salón, no una sesión de soporte.");
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, slugChangedAt: true },
    });
    if (!tenant) throw new NotFoundException("Salon not found");
    if (tenant.slugChangedAt) throw new BadRequestException(WEB_ADDRESS_ALREADY_CHANGED);
    const check = await this.availability(input, tenantId);
    if (check.slug === tenant.slug) throw new BadRequestException("Esa ya es la dirección de tu salón.");
    if (!check.available) throw new BadRequestException(check.message);

    const expiresAt = redirectExpiry(now);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.tenantSlugRedirect.deleteMany({ where: { oldSlug: check.slug, expiresAt: { lte: now } } });
        // A stale row for the address being left (expired) would block the new one.
        await tx.tenantSlugRedirect.deleteMany({ where: { oldSlug: tenant.slug } });
        const claimed = await tx.tenant.updateMany({
          where: { id: tenantId, slugChangedAt: null },
          data: { slug: check.slug, slugChangedAt: now },
        });
        if (claimed.count === 0) throw new BadRequestException(WEB_ADDRESS_ALREADY_CHANGED);
        await tx.tenantSlugRedirect.create({ data: { oldSlug: tenant.slug, tenantId, expiresAt } });
        await this.auditLog.record(
          "tenant.web_address_changed",
          {
            actorId: actor.id,
            actorRole: actor.role as UserRole,
            tenantId,
            metadata: { from: tenant.slug, to: check.slug, redirectsUntil: expiresAt.toISOString() },
          },
          tx,
        );
      });
    } catch (e: any) {
      if (e?.code === "P2002") throw new ConflictException(WEB_ADDRESS_MESSAGES.taken);
      throw e;
    }
    return { slug: check.slug, previous: tenant.slug, redirectsUntil: expiresAt };
  }
}
