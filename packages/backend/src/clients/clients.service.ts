import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { CreateClientDto, UpdateClientDto } from "./dto";
import { validateNif } from "../common/validation/nif.validator";

export interface ClientFilters {
  gender?: "male" | "female" | "other";
  minAge?: number;
  maxAge?: number;
  tags?: string[];
  loyaltyTier?: "bronze" | "silver" | "gold" | "platinum";
  status?: "active" | "inactive" | "blocked";
  minTotalSpent?: number;
  maxTotalSpent?: number;
  minVisits?: number;
  maxVisits?: number;
  hasEmail?: boolean;
}

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createClientDto: CreateClientDto) {
    // Validate NIF format — AEAT / hacienda rejects malformed identifiers.
    if (createClientDto.taxId) {
      const v = validateNif(createClientDto.taxId);
      if (!v.valid) {
        throw new BadRequestException(
          `taxId invalid (${v.error}): expected NIF/CIF/NIE in canonical form`,
        );
      }
      createClientDto.taxId = v.normalized ?? createClientDto.taxId;
    }
    return this.prisma.client.create({
      data: {
        tenantId: createClientDto.tenantId,
        firstName: createClientDto.firstName,
        lastName: createClientDto.lastName,
        email: createClientDto.email,
        phone: createClientDto.phone,
        dateOfBirth: createClientDto.dateOfBirth
          ? new Date(createClientDto.dateOfBirth)
          : null,
        gender: createClientDto.gender,
        profileImage: createClientDto.profileImage,
        taxId: createClientDto.taxId,
        taxIdType: createClientDto.taxIdType,
        status: "active",
      },
    });
  }

  async findAll(tenantId?: string, professionalId?: string) {
    const where: any = {};

    if (tenantId) {
      where.tenantId = tenantId;
    }

    // Si se especifica professionalId (para Staff), filtrar solo clientes que tienen citas con ese profesional
    if (professionalId) {
      where.appointments = {
        some: {
          professionalId: professionalId,
        },
      };
    }

    return this.prisma.client.findMany({
      where,
    });
  }

  async findAllWithFilters(tenantId: string, filters: ClientFilters) {
    const now = new Date();
    const where: any = { tenantId };

    // Validate age filters
    if (filters.minAge !== undefined) {
      if (filters.minAge < 0 || filters.minAge > 120) {
        throw new BadRequestException(
          "La edad mínima debe estar entre 0 y 120",
        );
      }
    }

    if (filters.maxAge !== undefined) {
      if (filters.maxAge < 0 || filters.maxAge > 120) {
        throw new BadRequestException(
          "La edad máxima debe estar entre 0 y 120",
        );
      }
    }

    if (
      filters.minAge !== undefined &&
      filters.maxAge !== undefined &&
      filters.minAge > filters.maxAge
    ) {
      throw new BadRequestException(
        "La edad mínima no puede ser mayor que la edad máxima",
      );
    }

    // Filter by gender
    if (filters.gender) {
      where.gender = filters.gender;
    }

    // Filter by age range (calculate from dateOfBirth)
    if (filters.minAge !== undefined || filters.maxAge !== undefined) {
      if (filters.minAge !== undefined) {
        const maxBirthDate = new Date(
          now.getFullYear() - filters.minAge,
          now.getMonth(),
          now.getDate(),
        );
        where.dateOfBirth = { ...where.dateOfBirth, lte: maxBirthDate };
      }
      if (filters.maxAge !== undefined) {
        const minBirthDate = new Date(
          now.getFullYear() - filters.maxAge - 1,
          now.getMonth(),
          now.getDate(),
        );
        where.dateOfBirth = { ...where.dateOfBirth, gte: minBirthDate };
      }
    }

    // Filter by tags
    if (filters.tags && filters.tags.length > 0) {
      where.tags = {
        hasSome: filters.tags,
      };
    }

    // Filter by loyalty tier
    if (filters.loyaltyTier) {
      where.loyaltyTier = filters.loyaltyTier;
    }

    // Filter by status
    if (filters.status) {
      where.status = filters.status;
    } else {
      // Default to active clients only
      where.status = "active";
    }

    // Filter by total spent
    if (filters.minTotalSpent !== undefined) {
      where.totalSpent = { ...where.totalSpent, gte: filters.minTotalSpent };
    }
    if (filters.maxTotalSpent !== undefined) {
      where.totalSpent = { ...where.totalSpent, lte: filters.maxTotalSpent };
    }

    // Filter by visit count
    if (filters.minVisits !== undefined) {
      where.visitCount = { ...where.visitCount, gte: filters.minVisits };
    }
    if (filters.maxVisits !== undefined) {
      where.visitCount = { ...where.visitCount, lte: filters.maxVisits };
    }

    // Filter by email presence
    if (filters.hasEmail) {
      where.email = { not: null };
    }

    return this.prisma.client.findMany({
      where,
    });
  }

  async findOne(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
    });

    if (!client) {
      throw new NotFoundException(`Client with ID ${id} not found`);
    }

    return client;
  }

  async update(id: string, updateClientDto: UpdateClientDto) {
    const client = await this.prisma.client.findUnique({
      where: { id },
    });

    if (!client) {
      throw new NotFoundException(`Client with ID ${id} not found`);
    }

    // Validate NIF format when supplied.
    if (updateClientDto.taxId) {
      const v = validateNif(updateClientDto.taxId);
      if (!v.valid) {
        throw new BadRequestException(
          `taxId invalid (${v.error}): expected NIF/CIF/NIE in canonical form`,
        );
      }
      updateClientDto.taxId = v.normalized ?? updateClientDto.taxId;
    }

    return this.prisma.client.update({
      where: { id },
      data: {
        firstName: updateClientDto.firstName,
        lastName: updateClientDto.lastName,
        email: updateClientDto.email,
        phone: updateClientDto.phone,
        preferredLanguage: updateClientDto.preferredLanguage,
        preferredServices: updateClientDto.preferredServices,
        preferredProfessionals: updateClientDto.preferredProfessionals,
        preferredTimes: updateClientDto.preferredTimes,
        communicationPreferences: updateClientDto.communicationPreferences,
        status: updateClientDto.status,
        taxId: updateClientDto.taxId,
        taxIdType: updateClientDto.taxIdType,
      },
    });
  }

  async remove(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
    });

    if (!client) {
      throw new NotFoundException(`Client with ID ${id} not found`);
    }

    return this.prisma.client.delete({
      where: { id },
    });
  }
}
