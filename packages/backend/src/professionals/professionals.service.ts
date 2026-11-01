import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";

/**
 * What anyone may see about a professional: what the salon's public site
 * shows. Everything else on the row -- email, phone, userId, commissionRate,
 * hireDate, terminationDate, availability, settings, stats, isOwner -- is
 * for the salon's owner and admins (and the professional themself).
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
  workingHours: true,
  services: { include: { service: true } },
} as const;

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
   * (inactive ones too: they are on past appointments) in the public
   * projection, and their own record in full: a colleague's email, phone or
   * commission rate is not theirs to see. Everyone else gets
   * PUBLIC_PROFESSIONAL and only active professionals: the public site, the
   * client portal and anonymous callers.
   */
  async findAll(tenantId: string, viewer: ProfessionalsViewer) {
    if (!viewer.staff) {
      return this.prisma.professional.findMany({
        where: { tenantId, isActive: true },
        select: PUBLIC_PROFESSIONAL,
      });
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
      this.prisma.professional.findMany({ where: { tenantId }, select: PUBLIC_PROFESSIONAL }),
      viewer.userId
        ? this.prisma.professional.findFirst({
            where: { tenantId, userId: viewer.userId },
            include: { services: { include: { service: true } } },
          })
        : Promise.resolve(null),
    ]);
    return own ? team.map((p) => (p.id === own.id ? own : p)) : team;
  }

  /** A full row reduced to what PUBLIC_PROFESSIONAL exposes. */
  toPublic<T extends Record<string, any>>(professional: T) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(PUBLIC_PROFESSIONAL)) {
      if (key in professional) out[key] = professional[key];
    }
    return out;
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
