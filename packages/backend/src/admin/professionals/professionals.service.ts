import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { deleteProfessionalKeepingHistory } from "../../common/prisma/history-deletes";
import {
  CreateProfessionalDto,
  UpdateProfessionalDto,
  ChangeProfessionalPasswordDto,
} from "./dto";
import { Professional, UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { assertProfessionalSlot } from "../../professionals/professional-limit";
import { commissionRateUpdate } from "../../professionals/optional-fields";
import { CLIENT_POS_SELECT } from "../../clients/client-select";

@Injectable()
export class AdminProfessionalsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createProfessionalDto: CreateProfessionalDto) {
    const { serviceIds, ...professionalData } = createProfessionalDto;
    // Outside the try: its catch turns every error into a 400.
    await assertProfessionalSlot(this.prisma, professionalData.tenantId);

    try {
      // The controller sets tenantId from the caller's token. This used to
      // fall back, for an unknown tenant, to the FIRST tenant in the database
      // -- or to creating a "Default Tenant" -- and put the professional
      // there: a write into another salon. Now an unknown tenant is an error.
      const tenant = await this.prisma.tenant.findFirst({
        where: { id: professionalData.tenantId },
        select: { id: true },
      });
      if (!tenant) {
        throw new NotFoundException("Salon not found");
      }

      const professional = await this.prisma.professional.create({
        data: {
          tenantId: professionalData.tenantId,
          firstName: professionalData.firstName,
          lastName: professionalData.lastName,
          email: professionalData.email,
          phone: professionalData.phone,
          profileImage: professionalData.profileImage,
          bio: professionalData.bio,
          specialties: professionalData.specialties || [],
          isActive: true,
          isOwner: false,
          position: professionalData.position,
          // 0 is a rate: only "not given" (or null) means none.
          commissionRate: commissionRateUpdate(professionalData.commissionRate) ?? null,
          hireDate: professionalData.hireDate
            ? new Date(professionalData.hireDate)
            : new Date(),
          workingHours: professionalData.workingHours || [],
          availability: professionalData.availability || {},
          settings: professionalData.settings || {},
          stats: professionalData.stats || {},
          services:
            serviceIds && serviceIds.length > 0
              ? {
                  create: serviceIds.map((serviceId) => ({
                    serviceId,
                  })),
                }
              : undefined,
        },
      });
      return professional;
    } catch (error) {
      console.error("Error creating professional:", error);
      if (error.code === "P2002") {
        throw new BadRequestException(
          "Professional with this email already exists",
        );
      } else if (error.code === "P2003") {
        throw new BadRequestException("One or more services do not exist");
      }
      throw new BadRequestException(
        `Failed to create professional: ${error.message}`,
      );
    }
  }

  async findAll({
    tenantId,
    page = 1,
    limit = 10,
    search = "",
    status,
  }: {
    tenantId: string;
    page: number;
    limit: number;
    search: string;
    status?: string;
  }) {
    const where: any = {
      tenantId,
      OR: [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
      ],
    };

    if (status) {
      where.isActive = status === "active";
    }

    const [professionals, total] = await Promise.all([
      this.prisma.professional.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { lastName: "asc" },
        include: {
          appointments: true,
          services: {
            include: {
              service: true,
            },
          },
          user: { select: { role: true, isActive: true, email: true, lastLoginAt: true } },
        },
      }),
      this.prisma.professional.count({ where }),
    ]);

    return {
      data: professionals.map(({ user, ...p }) => ({ ...p, panelAccess: panelAccessOf(user) })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(tenantId: string, id: string) {
    const professional = await this.prisma.professional.findUnique({
      where: { id, tenantId },
      include: {
        // Bounded on purpose: this used to pull every appointment the
        // professional had ever had, each with its service and client, so the
        // response grew with the salon's age instead of with what the detail
        // view shows. Most recent first, capped.
        appointments: {
          include: {
            service: true,
            client: { select: CLIENT_POS_SELECT },
          },
          orderBy: { scheduledDate: "desc" },
          take: 50,
        },
        services: {
          include: {
            service: true,
          },
        },
      },
    });

    if (!professional) {
      throw new NotFoundException("Professional not found");
    }

    return professional;
  }

  async update(tenantId: string, id: string, updateProfessionalDto: UpdateProfessionalDto) {
    const { serviceIds, ...professionalData } = updateProfessionalDto;
    if (professionalData.isActive === true) {
      const current = await this.prisma.professional.findFirst({
        where: { id, tenantId },
        select: { isActive: true },
      });
      if (current && !current.isActive) await assertProfessionalSlot(this.prisma, tenantId);
    }

    try {
      // First, update the professional data
      const professional = await this.prisma.professional.update({
        where: { id, tenantId },
        data: professionalData,
      });

      // Then handle service associations if provided and has values
      if (serviceIds && serviceIds.length > 0) {
        // Delete existing service associations
        await this.prisma.professionalService.deleteMany({
          where: { professionalId: id },
        });

        // Create new service associations
        await this.prisma.professionalService.createMany({
          data: serviceIds.map((serviceId) => ({
            professionalId: id,
            serviceId,
          })),
        });
      }

      return professional;
    } catch (error) {
      console.error("Error updating professional:", error);
      if (error.code === "P2025") {
        throw new NotFoundException("Professional not found");
      }
      if (error.code === "P2002") {
        throw new BadRequestException(
          "Professional with this email already exists",
        );
      }
      if (error.code === "P2003") {
        throw new BadRequestException("One or more services do not exist");
      }
      throw new BadRequestException(
        `Failed to update professional: ${error.message}`,
      );
    }
  }

  /** History survives the delete: see common/prisma/history-deletes.ts. */
  async remove(tenantId: string, id: string) {
    return deleteProfessionalKeepingHistory(this.prisma, tenantId, id);
  }

  async search(tenantId: string, query: string) {
    const professionals = await this.prisma.professional.findMany({
      where: {
        tenantId,
        OR: [
          { firstName: { contains: query, mode: "insensitive" } },
          { lastName: { contains: query, mode: "insensitive" } },
          { email: { contains: query, mode: "insensitive" } },
          { phone: { contains: query, mode: "insensitive" } },
        ],
      },
      take: 10,
      orderBy: { lastName: "asc" },
    });

    return professionals;
  }

  async getAvailability(tenantId: string, id: string) {
    const professional = await this.prisma.professional.findUnique({
      where: { id, tenantId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        workingHours: true,
        availability: true,
        appointments: {
          where: {
            status: { not: "cancelled" },
            scheduledDate: { gte: new Date() },
          },
          select: {
            id: true,
            scheduledDate: true,
            scheduledTime: true,
            duration: true,
            status: true,
          },
        },
      },
    });

    if (!professional) {
      throw new NotFoundException("Professional not found");
    }

    return {
      professionalId: professional.id,
      name: `${professional.firstName} ${professional.lastName}`,
      workingHours: professional.workingHours,
      availability: professional.availability,
      upcomingAppointments: professional.appointments,
    };
  }

  async changePassword(
    tenantId: string,
    id: string,
    changePasswordDto: ChangeProfessionalPasswordDto,
  ) {
    const professional = await this.prisma.professional.findUnique({
      where: { id, tenantId },
      include: { user: true },
    });

    if (!professional) {
      throw new NotFoundException("Professional not found");
    }

    if (!professional.user) {
      throw new BadRequestException(
        "Este profesional todavía no tiene acceso al panel. Dale acceso primero.",
      );
    }
    // The owner's own record is linked to the owner's account: an admin must
    // not be able to reset the owner's password from the team screen.
    if (professional.user.role !== UserRole.staff) {
      throw new BadRequestException(
        "Esta ficha es la de la cuenta principal del salón: su contraseña se cambia desde esa cuenta.",
      );
    }

    try {
      // Hash the new password
      const passwordHash = await bcrypt.hash(
        changePasswordDto.newPassword,
        Number(process.env.BCRYPT_ROUNDS) || 12,
      );

      // Update the user's password hash
      // A new password ends the sessions opened with the old one.
      await this.prisma.user.update({
        where: { id: professional.userId! },
        data: { passwordHash, tokenVersion: { increment: 1 }, loginAttempts: 0, lockedUntil: null },
      });

      return { success: true, message: "Password updated successfully" };
    } catch (error) {
      console.error("Error updating professional password:", error);
      throw new BadRequestException("Failed to update password");
    }
  }

  /**
   * Gives a professional their own login to the panel: a staff account with
   * the email on their record and a first password the owner sets and hands
   * over (email delivery is not set up yet). Creating a professional only
   * ever created the record, so no professional could sign in, and the
   * "change password" button always failed for want of an account.
   *
   * Again on a professional whose access was removed: reactivated, with the
   * new password. Never on the owner's own record (another role's account).
   */
  async grantPanelAccess(tenantId: string, id: string, password: string) {
    const professional = await this.prisma.professional.findFirst({
      where: { id, tenantId },
      include: { user: { select: { id: true, role: true } } },
    });
    if (!professional) throw new NotFoundException("Professional not found");
    const email = professional.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException("Pon un email en la ficha: es con el que entrará al panel.");
    }
    const passwordHash = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS) || 12);

    if (professional.user) {
      if (professional.user.role !== UserRole.staff) {
        throw new BadRequestException(
          "Esta ficha es la de la cuenta principal del salón, que ya entra al panel.",
        );
      }
      await this.prisma.user.update({
        where: { id: professional.user.id },
        data: {
          passwordHash,
          isActive: true,
          tokenVersion: { increment: 1 },
          loginAttempts: 0,
          lockedUntil: null,
        },
      });
      return { active: true, email };
    }

    const taken = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (taken) {
      throw new ConflictException(
        "Ese email ya es de otra cuenta de KiraRoom. Pon en la ficha un email propio del profesional.",
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId,
          email,
          firstName: professional.firstName,
          lastName: professional.lastName,
          role: UserRole.staff,
          passwordHash,
          professionalId: professional.id,
          isActive: true,
        },
        select: { id: true },
      });
      await tx.professional.update({ where: { id: professional.id }, data: { userId: user.id } });
    });
    return { active: true, email };
  }

  /** Removes a professional's login: the account is deactivated and its sessions end. */
  async revokePanelAccess(tenantId: string, id: string) {
    const professional = await this.prisma.professional.findFirst({
      where: { id, tenantId },
      include: { user: { select: { id: true, role: true } } },
    });
    if (!professional) throw new NotFoundException("Professional not found");
    if (!professional.user) return { active: false };
    if (professional.user.role !== UserRole.staff) {
      throw new BadRequestException("La cuenta principal del salón no se puede desactivar desde aquí.");
    }
    await this.prisma.user.update({
      where: { id: professional.user.id },
      data: { isActive: false, tokenVersion: { increment: 1 } },
    });
    return { active: false };
  }
}

/** What the team list shows about a professional's login. */
export function panelAccessOf(
  user: { role: UserRole; isActive: boolean; email: string; lastLoginAt: Date | null } | null | undefined,
) {
  if (!user) return { status: "none" as const };
  if (user.role !== UserRole.staff) return { status: "owner" as const, email: user.email };
  return {
    status: user.isActive ? ("active" as const) : ("revoked" as const),
    email: user.email,
    lastLoginAt: user.lastLoginAt,
  };
}

