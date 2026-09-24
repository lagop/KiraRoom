import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import {
  CreateProfessionalDto,
  UpdateProfessionalDto,
  ChangeProfessionalPasswordDto,
} from "./dto";
import { Professional } from "@prisma/client";
import * as bcrypt from "bcryptjs";

@Injectable()
export class AdminProfessionalsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createProfessionalDto: CreateProfessionalDto) {
    const { serviceIds, ...professionalData } = createProfessionalDto;

    try {
      // Check if tenant exists, if not use first available tenant or create a new one
      let tenant = await this.prisma.tenant.findFirst({
        where: { id: professionalData.tenantId },
      });

      if (!tenant) {
        // Try to find any existing tenant
        tenant = await this.prisma.tenant.findFirst();

        if (!tenant) {
          // Create a new tenant if none exists
          tenant = await this.prisma.tenant.create({
            data: {
              name: "Default Tenant",
              slug: "default-tenant",
              email: "admin@default.com",
              phone: "+1234567890",
              currency: "EUR",
              plan: "basic",
              subscriptionStatus: "active",
              currentPeriodStart: new Date(),
              currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
            },
          });
        }

        professionalData.tenantId = tenant.id;
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
          commissionRate: professionalData.commissionRate
            ? parseFloat(String(professionalData.commissionRate))
            : null,
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
        },
      }),
      this.prisma.professional.count({ where }),
    ]);

    return {
      data: professionals,
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
            client: true,
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

  async remove(tenantId: string, id: string) {
    try {
      return await this.prisma.professional.delete({
        where: { id, tenantId },
      });
    } catch (error) {
      if (error.code === "P2025") {
        throw new NotFoundException("Professional not found");
      }
      throw new BadRequestException("Failed to delete professional");
    }
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
        "Professional does not have an associated user account",
      );
    }

    try {
      // Hash the new password
      const passwordHash = await bcrypt.hash(
        changePasswordDto.newPassword,
        Number(process.env.BCRYPT_ROUNDS) || 12,
      );

      // Update the user's password hash
      await this.prisma.user.update({
        where: { id: professional.userId! },
        data: { passwordHash },
      });

      return { success: true, message: "Password updated successfully" };
    } catch (error) {
      console.error("Error updating professional password:", error);
      throw new BadRequestException("Failed to update password");
    }
  }
}
