import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { publicProfessionals } from "../public-site/public-professional";

/**
 * The services a professional offers that anyone may know about: active and
 * bookable online, by id only. The salon's own catalogue rows (net price,
 * deposits, products, equipment, SEO fields, phone-only services) are not
 * public; GET /services has the public projection of the catalogue.
 */
export const PUBLIC_PROFESSIONAL_SERVICES = {
  where: { service: { isActive: true, isOnlineBookable: true } },
  select: { serviceId: true },
} as const;

/**
 * What anyone may see about a professional: what the salon's public site
 * shows. Everything else on the row -- email, phone, userId, commissionRate,
 * hireDate, terminationDate, availability, settings, stats, isOwner -- is
 * for the salon's owner and admins (and the professional themself).
 *
 * Not her weekly schedule either: GET /professionals?tenantId= answers
 * without a session, and "when is each one at work" (when is someone alone
 * in the salon) is not for anyone who knows the salon's id. The public page
 * sums the schedules up into the salon's hours (public-site.service.ts).
 *
 * Read with her "Mostrar en la web" choice (webNameDisplay, webShowPhoto)
 * and always answered through publicProfessionals (public-professional.ts):
 * the name as she agreed to show it, her pictures as URLs and only if shown.
 */
export const PUBLIC_PROFESSIONAL = {
  id: true,
  tenantId: true,
  firstName: true,
  lastName: true,
  profileImage: true,
  bio: true,
  specialties: true,
  portfolioImages: true,
  yearsExperience: true,
  languages: true,
  certifications: true,
  position: true,
  isActive: true,
  webNameDisplay: true,
  webShowPhoto: true,
  services: PUBLIC_PROFESSIONAL_SERVICES,
} as const;

/**
 * What the salon's staff (not the owner or admins) see about a colleague:
 * the public fields plus what the calendar and the booking drawer need,
 * her working hours and the services she does with their rows.
 */
export const COLLEAGUE_PROFESSIONAL = {
  ...PUBLIC_PROFESSIONAL,
  workingHours: true,
  services: { include: { service: true } },
} as const;

function pick(row: Record<string, any>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

/** Who is asking (see PublicViewerService): staff of the salon, and which. */
export interface ProfessionalsViewer {
  staff: boolean;
  role?: string;
  userId?: string;
}

/** The owner and admins see every colleague's full row; a professional, only their own. */
export function seesFullRows(viewer: ProfessionalsViewer): boolean {
  return viewer.staff && (viewer.role === "owner" || viewer.role === "admin");
}

/**
 * Reads of professionals for the calendar, the booking flows and the
 * virtual receptionist. Creating, editing and deleting go through
 * AdminProfessionalsService (also behind the legacy POST/PUT/DELETE
 * /professionals), so there is one set of rules for them.
 */
@Injectable()
export class ProfessionalsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The owner and admins get full rows. Other staff get every colleague
   * (inactive ones too: they are on past appointments) in the colleague
   * projection, and their own record in full: a colleague's email, phone or
   * commission rate is not theirs to see. Everyone else gets
   * PUBLIC_PROFESSIONAL and only active professionals: the public site, the
   * client portal and anonymous callers.
   */
  async findAll(tenantId: string, viewer: ProfessionalsViewer) {
    if (!viewer.staff) {
      const rows = await this.prisma.professional.findMany({
        where: { tenantId, isActive: true },
        select: PUBLIC_PROFESSIONAL,
      });
      return publicProfessionals(rows);
    }
    if (seesFullRows(viewer)) {
      return this.prisma.professional.findMany({
        where: { tenantId },
        include: {
          services: {
            include: {
              service: true,
            },
          },
        },
      });
    }
    const [team, own] = await Promise.all([
      this.prisma.professional.findMany({ where: { tenantId }, select: COLLEAGUE_PROFESSIONAL }),
      viewer.userId
        ? this.prisma.professional.findFirst({
            where: { tenantId, userId: viewer.userId },
            include: { services: { include: { service: true } } },
          })
        : Promise.resolve(null),
    ]);
    return own ? team.map((p) => (p.id === own.id ? own : p)) : team;
  }

  /**
   * A full row (with `services: [{ serviceId, service }]`) reduced to what
   * PUBLIC_PROFESSIONAL exposes: the services by id, only those active and
   * bookable online.
   */
  toPublic<T extends Record<string, any>>(professional: T) {
    const out = pick(professional, Object.keys(PUBLIC_PROFESSIONAL));
    if (Array.isArray(professional.services)) {
      out.services = professional.services
        .filter((ps: any) => !ps?.service || (ps.service.isActive !== false && ps.service.isOnlineBookable !== false))
        .map((ps: any) => ({ serviceId: ps.serviceId ?? ps.service?.id }));
    }
    return publicProfessionals([out as any])[0];
  }

  /** A full row reduced to what a colleague (staff) sees: COLLEAGUE_PROFESSIONAL. */
  toColleague<T extends Record<string, any>>(professional: T) {
    return pick(professional, Object.keys(COLLEAGUE_PROFESSIONAL));
  }

  /**
   * Get active professionals for a specific salon with their services
   */
  async getActiveProfessionalsBySalon(salonId: string) {
    return this.prisma.professional.findMany({
      where: {
        tenantId: salonId,
        isActive: true,
      },
      include: {
        services: {
          include: {
            service: true,
          },
        },
      },
    });
  }

  /**
   * Get professional by name for a specific salon
   */
  async findProfessionalByName(salonId: string, name: string) {
    const professionals = await this.getActiveProfessionalsBySalon(salonId);
    return professionals.find(
      (professional) =>
        `${professional.firstName} ${professional.lastName}`
          .toLowerCase()
          .includes(name.toLowerCase()) ||
        professional.firstName.toLowerCase().includes(name.toLowerCase()) ||
        professional.lastName.toLowerCase().includes(name.toLowerCase()),
    );
  }

  async findOne(id: string) {
    const professional = await this.prisma.professional.findUnique({
      where: { id },
      include: {
        services: {
          include: {
            service: true,
          },
        },
      },
    });

    if (!professional) {
      throw new NotFoundException("Profesional no encontrado");
    }

    return professional;
  }

  /**
   * Get professional by user ID
   */
  async getProfessionalByUserId(userId: string, tenantId: string) {
    return this.prisma.professional.findFirst({
      where: { userId, tenantId },
      select: { id: true, firstName: true, lastName: true },
    });
  }
}
