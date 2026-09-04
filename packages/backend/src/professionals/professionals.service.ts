import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { CreateProfessionalDto, UpdateProfessionalDto } from "./dto";

@Injectable()
export class ProfessionalsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createProfessionalDto: CreateProfessionalDto) {
    return this.prisma.professional.create({
      data: {
        tenantId: createProfessionalDto.tenantId,
        firstName: createProfessionalDto.firstName,
        lastName: createProfessionalDto.lastName,
        email: createProfessionalDto.email,
        phone: createProfessionalDto.phone,
        profileImage: createProfessionalDto.profileImage,
        bio: createProfessionalDto.bio,
        specialties: createProfessionalDto.specialties || [],
        isActive: createProfessionalDto.isActive || true,
        isOwner: createProfessionalDto.isOwner || false,
        position: createProfessionalDto.position,
        commissionRate: createProfessionalDto.commissionRate
          ? parseFloat(createProfessionalDto.commissionRate)
          : null,
        hireDate: createProfessionalDto.hireDate
          ? new Date(createProfessionalDto.hireDate)
          : new Date(),
        terminationDate: createProfessionalDto.terminationDate
          ? new Date(createProfessionalDto.terminationDate)
          : null,
        workingHours: createProfessionalDto.workingHours || [],
        availability: createProfessionalDto.availability || {},
        settings: createProfessionalDto.settings || {},
        stats: createProfessionalDto.stats || {},
      },
    });
  }

  async findAll(tenantId?: string) {
    return this.prisma.professional.findMany({
      where: tenantId ? { tenantId } : {},
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
      throw new NotFoundException(`Professional with ID ${id} not found`);
    }

    return professional;
  }

  async update(id: string, updateProfessionalDto: UpdateProfessionalDto) {
    const professional = await this.prisma.professional.findUnique({
      where: { id },
    });

    if (!professional) {
      throw new NotFoundException(`Professional with ID ${id} not found`);
    }

    return this.prisma.professional.update({
      where: { id },
      data: {
        firstName: updateProfessionalDto.firstName,
        lastName: updateProfessionalDto.lastName,
        email: updateProfessionalDto.email,
        phone: updateProfessionalDto.phone,
        profileImage: updateProfessionalDto.profileImage,
        bio: updateProfessionalDto.bio,
        specialties: updateProfessionalDto.specialties,
        isActive: updateProfessionalDto.isActive,
        isOwner: updateProfessionalDto.isOwner,
        position: updateProfessionalDto.position,
        commissionRate: updateProfessionalDto.commissionRate
          ? parseFloat(updateProfessionalDto.commissionRate)
          : null,
        hireDate: updateProfessionalDto.hireDate
          ? new Date(updateProfessionalDto.hireDate)
          : undefined,
        terminationDate: updateProfessionalDto.terminationDate
          ? new Date(updateProfessionalDto.terminationDate)
          : undefined,
        workingHours: updateProfessionalDto.workingHours,
        availability: updateProfessionalDto.availability,
        settings: updateProfessionalDto.settings,
        stats: updateProfessionalDto.stats,
      },
    });
  }

  async remove(id: string) {
    const professional = await this.prisma.professional.findUnique({
      where: { id },
    });

    if (!professional) {
      throw new NotFoundException(`Professional with ID ${id} not found`);
    }

    return this.prisma.professional.delete({
      where: { id },
    });
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
