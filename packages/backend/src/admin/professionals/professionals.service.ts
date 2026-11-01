import {
  Injectable,
  Logger,
  HttpException,
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
import { AppointmentStatus, UserRole } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { withProfessionalSlot } from "../../professionals/professional-limit";
import {
  commissionRateUpdate,
  optionalDateUpdate,
  requiredDateUpdate,
} from "../../professionals/optional-fields";
import { revokePanelLogin } from "../../professionals/panel-login";
import { CLIENT_POS_SELECT } from "../../clients/client-select";

/** The most the team list returns at once: every salon's whole team fits. */
export const MAX_PROFESSIONALS_PAGE = 200;

export const PROFESSIONAL_NOT_FOUND = "Profesional no encontrado";
export const PROFESSIONAL_EMAIL_TAKEN =
  "Ese email ya lo usa otro profesional. Pon uno distinto.";
export const LOGIN_EMAIL_TAKEN =
  "Ese email ya es de otra cuenta de KiraRoom, así que no puede ser con el que este profesional entra al panel. Pon un email propio del profesional.";
const SERVICE_MISSING = "Alguno de los servicios elegidos ya no existe. Recarga la página y vuelve a elegirlos.";

/** Statuses of an appointment still to happen: what deactivating leaves without a professional. */
const UPCOMING_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.pending,
  AppointmentStatus.confirmed,
  AppointmentStatus.in_progress,
];

/** Creating with `isActive: false` (the legacy POST /professionals allows it). */
type CreateInput = CreateProfessionalDto & { tenantId: string; isActive?: boolean; terminationDate?: string | null };

@Injectable()
export class AdminProfessionalsService {
  private readonly logger = new Logger(AdminProfessionalsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A known Prisma error as a Spanish message the panel can show. Anything
   * else is logged here and answered with a generic message: the raw Prisma
   * text (English, with table and column names) used to go to the salon.
   */
  private saveError(error: any, action: "create" | "update"): never {
    if (error instanceof HttpException) throw error;
    if (error?.code === "P2025") throw new NotFoundException(PROFESSIONAL_NOT_FOUND);
    if (error?.code === "P2002") throw new ConflictException(PROFESSIONAL_EMAIL_TAKEN);
    if (error?.code === "P2003") throw new BadRequestException(SERVICE_MISSING);
    this.logger.error(`Error on professional ${action}: ${error?.message ?? error}`, error?.stack);
    throw new BadRequestException(
      action === "create"
        ? "No se ha podido crear el profesional. Revisa los datos e inténtalo de nuevo."
        : "No se han podido guardar los cambios. Revisa los datos e inténtalo de nuevo.",
    );
  }

  async create(createProfessionalDto: CreateInput) {
    const { serviceIds, ...professionalData } = createProfessionalDto;
    const isActive = professionalData.isActive ?? true;

    // The controller sets tenantId from the caller's token. This used to
    // fall back, for an unknown tenant, to the FIRST tenant in the database
    // -- or to creating a "Default Tenant" -- and put the professional
    // there: a write into another salon. Now an unknown tenant is an error.
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: professionalData.tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException("Salón no encontrado");
    }

    const write = (db: Pick<Prisma.TransactionClient, "professional">) =>
      db.professional.create({
        data: {
          tenantId: professionalData.tenantId,
          firstName: professionalData.firstName,
          lastName: professionalData.lastName,
          email: professionalData.email,
          phone: professionalData.phone,
          profileImage: professionalData.profileImage,
          bio: professionalData.bio,
          specialties: professionalData.specialties || [],
          isActive,
          isOwner: false,
          position: professionalData.position,
          // 0 is a rate: only "not given" (or null) means none.
          commissionRate: commissionRateUpdate(professionalData.commissionRate) ?? null,
          hireDate: requiredDateUpdate(professionalData.hireDate) ?? new Date(),
          terminationDate: optionalDateUpdate(professionalData.terminationDate) ?? null,
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

    try {
      // An active professional takes one of the plan's places: counted and
      // created under the salon's lock, so two adds at once cannot both fit.
      return isActive
        ? await withProfessionalSlot(this.prisma, professionalData.tenantId, write)
        : await write(this.prisma);
    } catch (error) {
      this.saveError(error, "create");
    }
  }

  /**
   * How many appointments still to happen (today on) the professional has:
   * what deactivating them leaves to reassign.
   */
  async upcomingAppointmentCount(tenantId: string, id: string) {
    const professional = await this.prisma.professional.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!professional) throw new NotFoundException(PROFESSIONAL_NOT_FOUND);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const count = await this.prisma.appointment.count({
      where: {
        tenantId,
        professionalId: id,
        scheduledDate: { gte: today },
        status: { in: UPCOMING_STATUSES },
      },
    });
    return { count };
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
        // No appointments here: this pulled every appointment each
        // professional ever had, for a list that shows none of them.
        include: {
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
      throw new NotFoundException(PROFESSIONAL_NOT_FOUND);
    }

    return professional;
  }

  async update(tenantId: string, id: string, updateProfessionalDto: UpdateProfessionalDto) {
    // tenantId is in the DTO only because it extends the create one: the salon is
    // the caller's, never moved by a body.
    const { serviceIds, hireDate, terminationDate, tenantId: _tenantId, ...fields } = updateProfessionalDto;
    const current = await this.prisma.professional.findFirst({
      where: { id, tenantId },
      select: { isActive: true, email: true, user: { select: { id: true, role: true, email: true } } },
    });
    if (!current) throw new NotFoundException(PROFESSIONAL_NOT_FOUND);

    // Dates arrive as "YYYY-MM-DD" from the forms; Prisma wants a Date. Raw,
    // every edit from the team list that carried the hire date was a 400.
    const professionalData = {
      ...fields,
      hireDate: requiredDateUpdate(hireDate),
      terminationDate: optionalDateUpdate(terminationDate),
    };

    // The professional signs in with the email on their record (see
    // grantPanelAccess), so a new one there moves their login too -- if no
    // other account has it. The owner's own record is the salon's main
    // account, which is changed from that account, not from here.
    const login = current.user?.role === UserRole.staff ? current.user : null;
    const loginEmail = fields.email?.trim().toLowerCase();
    const moveLogin = !!login && !!loginEmail && loginEmail !== login.email.toLowerCase();
    if (moveLogin) {
      const taken = await this.prisma.user.findUnique({ where: { email: loginEmail }, select: { id: true } });
      if (taken && taken.id !== login!.id) throw new ConflictException(LOGIN_EMAIL_TAKEN);
    }

    try {
      // Back to active takes one of the plan's places: under the salon's
      // lock, so two reactivations at once cannot both fit.
      if (fields.isActive === true && !current.isActive) {
        await withProfessionalSlot(this.prisma, tenantId, (tx) =>
          tx.professional.update({ where: { id, tenantId }, data: { isActive: true } }),
        );
      }

      // First, update the professional data
      const professional = await this.prisma.professional.update({
        where: { id, tenantId },
        data: professionalData,
      });

      if (moveLogin) {
        await this.prisma.user.update({ where: { id: login!.id }, data: { email: loginEmail } });
      }
      // Deactivated: their own login goes too (it used to stay on). Coming
      // back does not restore it; the owner gives it again on purpose.
      if (fields.isActive === false) {
        await revokePanelLogin(this.prisma, tenantId, current.user?.id);
      }

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
      this.saveError(error, "update");
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
      throw new NotFoundException(PROFESSIONAL_NOT_FOUND);
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
      throw new NotFoundException(PROFESSIONAL_NOT_FOUND);
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

      return { success: true, message: "Contraseña actualizada" };
    } catch (error) {
      this.logger.error(`Error updating a professional password: ${(error as any)?.message ?? error}`);
      throw new BadRequestException("No se ha podido cambiar la contraseña. Inténtalo de nuevo.");
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
    if (!professional) throw new NotFoundException(PROFESSIONAL_NOT_FOUND);
    // Deactivating takes the login away (revokePanelLogin); it must not come
    // back while they are still inactive.
    if (!professional.isActive) {
      throw new BadRequestException(
        "Este profesional está desactivado. Actívalo primero y luego dale acceso al panel.",
      );
    }
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
    if (!professional) throw new NotFoundException(PROFESSIONAL_NOT_FOUND);
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

