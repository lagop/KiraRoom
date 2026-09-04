import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

@Injectable()
export class AdminSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfessionalCrossBooking(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { allowProfessionalCrossBooking: true },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    return {
      allowProfessionalCrossBooking: tenant.allowProfessionalCrossBooking,
    };
  }

  async updateProfessionalCrossBooking(
    tenantId: string,
    allowProfessionalCrossBooking: boolean,
  ) {
    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { allowProfessionalCrossBooking },
      select: { allowProfessionalCrossBooking: true },
    });

    return {
      allowProfessionalCrossBooking: tenant.allowProfessionalCrossBooking,
    };
  }
}
