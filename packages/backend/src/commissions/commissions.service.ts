import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { Decimal } from "@prisma/client/runtime/library";

export interface CalculateCommissionDto {
  appointmentId: string;
  amount?: number;
  rate?: number;
}

export interface PayCommissionDto {
  professionalId: string;
  appointmentIds?: string[];
  startDate?: Date;
  endDate?: Date;
}

export interface CommissionSummary {
  professionalId: string;
  professionalName: string;
  totalEarnings: number;
  pendingCommission: number;
  paidCommission: number;
  appointments: {
    id: string;
    date: Date;
    clientName: string;
    serviceName: string;
    amount: number;
    commissionRate: number;
    commissionAmount: number;
    paid: boolean;
  }[];
}

@Injectable()
export class CommissionsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Calculate commission for an appointment
   */
  async calculateCommission(
    tenantId: string,
    dto: CalculateCommissionDto,
  ): Promise<{ commissionRate: number; commissionAmount: number }> {
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        id: dto.appointmentId,
        tenantId,
      },
      include: {
        professional: true,
        service: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }

    // Use provided amount or the appointment total
    const amount = dto.amount ?? Number(appointment.totalAmount);

    // Use provided rate or professional's commission rate
    const rate =
      dto.rate ??
      (appointment.commissionRate
        ? Number(appointment.commissionRate)
        : appointment.professional.commissionRate
          ? Number(appointment.professional.commissionRate)
          : 10); // Default 10%

    const commissionAmount = (amount * rate) / 100;

    // Update appointment with commission details
    await this.prisma.appointment.update({
      where: { id: dto.appointmentId },
      data: {
        commissionRate: rate,
        commissionAmount,
      },
    });

    return {
      commissionRate: rate,
      commissionAmount,
    };
  }

  /**
   * Calculate commissions for all completed appointments for a professional
   */
  async calculatePendingCommissions(
    tenantId: string,
    professionalId: string,
  ): Promise<number> {
    const appointments = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        professionalId,
        status: "completed",
        paymentStatus: "paid",
        commissionPaid: false,
      },
    });

    const professional = await this.prisma.professional.findFirst({
      where: { id: professionalId, tenantId },
    });

    if (!professional) {
      throw new NotFoundException("Professional not found");
    }

    const defaultRate = professional.commissionRate
      ? Number(professional.commissionRate)
      : 10;

    let totalCommission = 0;

    for (const appointment of appointments) {
      const rate = appointment.commissionRate
        ? Number(appointment.commissionRate)
        : defaultRate;
      const amount = Number(appointment.totalAmount);
      const commissionAmount = (amount * rate) / 100;

      await this.prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          commissionRate: rate,
          commissionAmount,
        },
      });

      totalCommission += commissionAmount;
    }

    return totalCommission;
  }

  /**
   * Get commission summary for a professional
   */
  async getCommissionSummary(
    tenantId: string,
    professionalId: string,
  ): Promise<CommissionSummary> {
    const professional = await this.prisma.professional.findFirst({
      where: { id: professionalId, tenantId },
    });

    if (!professional) {
      throw new NotFoundException("Professional not found");
    }

    // Get all completed and paid appointments with commission data (exclude cancelled)
    const appointments = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        professionalId,
        status: "completed",
        paymentStatus: "paid",
        commissionPaid: false,
      },
      include: {
        client: true,
        service: true,
      },
      orderBy: {
        scheduledDate: "desc",
      },
    });

    const defaultRate = professional.commissionRate
      ? Number(professional.commissionRate)
      : 10;

    let pendingCommission = 0;
    let paidCommission = 0;

    const appointmentDetails = appointments.map((apt) => {
      const rate = apt.commissionRate
        ? Number(apt.commissionRate)
        : defaultRate;
      const amount = Number(apt.totalAmount);
      const commissionAmount = apt.commissionAmount
        ? Number(apt.commissionAmount)
        : (amount * rate) / 100;

      if (apt.commissionPaid) {
        paidCommission += commissionAmount;
      } else {
        pendingCommission += commissionAmount;
      }

      return {
        id: apt.id,
        date: apt.scheduledDate,
        clientName: `${apt.client.firstName} ${apt.client.lastName}`,
        serviceName: apt.service.name,
        amount,
        commissionRate: rate,
        commissionAmount,
        paid: apt.commissionPaid,
      };
    });

    return {
      professionalId: professional.id,
      professionalName: `${professional.firstName} ${professional.lastName}`,
      totalEarnings: appointmentDetails.reduce((sum, a) => sum + a.amount, 0),
      pendingCommission,
      paidCommission,
      appointments: appointmentDetails,
    };
  }

  /**
   * Pay commissions for completed appointments
   */
  async payCommission(
    tenantId: string,
    professionalId: string,
    dto: PayCommissionDto,
  ): Promise<{ count: number; totalAmount: number }> {
    const whereClause: any = {
      tenantId,
      professionalId,
      status: "completed",
      paymentStatus: "paid",
      commissionPaid: false,
    };

    // If specific appointment IDs provided
    if (dto.appointmentIds && dto.appointmentIds.length > 0) {
      whereClause.id = { in: dto.appointmentIds };
    }

    // If date range provided
    if (dto.startDate) {
      whereClause.scheduledDate = {
        ...whereClause.scheduledDate,
        gte: dto.startDate,
      };
    }

    if (dto.endDate) {
      whereClause.scheduledDate = {
        ...whereClause.scheduledDate,
        lte: dto.endDate,
      };
    }

    const appointments = await this.prisma.appointment.findMany({
      where: whereClause,
    });

    let totalAmount = 0;
    for (const apt of appointments) {
      totalAmount += Number(apt.commissionAmount || 0);
    }

    const result = await this.prisma.appointment.updateMany({
      where: whereClause,
      data: {
        commissionPaid: true,
        commissionDate: new Date(),
      },
    });

    return {
      count: result.count,
      totalAmount,
    };
  }

  /**
   * Get all professionals' commission summaries for a tenant
   */
  async getAllCommissionSummaries(
    tenantId: string,
  ): Promise<CommissionSummary[]> {
    const professionals = await this.prisma.professional.findMany({
      where: {
        tenantId,
        isActive: true,
      },
    });

    console.log(
      `Found ${professionals.length} active professionals for tenant ${tenantId}`,
    );
    console.log(
      "Active professionals:",
      professionals.map((p) => `${p.firstName} ${p.lastName}`).join(", "),
    );

    const summaries: CommissionSummary[] = [];

    for (const professional of professionals) {
      console.log(
        `Processing professional: ${professional.firstName} ${professional.lastName}, active: ${professional.isActive}`,
      );
      try {
        // Get professional's commission rate
        const defaultRate = professional.commissionRate
          ? Number(professional.commissionRate)
          : 10;

        // Get all appointments for this professional (completed and paid, not cancelled)
        const appointments = await this.prisma.appointment.findMany({
          where: {
            tenantId,
            professionalId: professional.id,
            status: "completed",
            paymentStatus: "paid",
            commissionPaid: false,
          },
          include: {
            client: true,
            service: true,
          },
          orderBy: {
            scheduledDate: "desc",
          },
        });

        console.log(
          `Professional ${professional.firstName} ${professional.lastName}: ${appointments.length} appointments`,
        );

        let pendingCommission = 0;
        let paidCommission = 0;

        const appointmentDetails = appointments.map((apt) => {
          const rate = apt.commissionRate
            ? Number(apt.commissionRate)
            : defaultRate;
          const amount = Number(apt.totalAmount);
          const commissionAmount = apt.commissionAmount
            ? Number(apt.commissionAmount)
            : (amount * rate) / 100;

          if (apt.commissionPaid) {
            paidCommission += commissionAmount;
          } else {
            pendingCommission += commissionAmount;
          }

          return {
            id: apt.id,
            date: apt.scheduledDate,
            clientName: apt.client
              ? `${apt.client.firstName} ${apt.client.lastName}`
              : "Unknown",
            serviceName: apt.service?.name || "Unknown Service",
            amount,
            commissionRate: rate,
            commissionAmount,
            paid: apt.commissionPaid,
          };
        });

        const totalEarnings = appointmentDetails.reduce(
          (sum, a) => sum + a.amount,
          0,
        );

        console.log(
          `Professional ${professional.firstName} ${professional.lastName}: pending=${pendingCommission}, paid=${paidCommission}, earnings=${totalEarnings}, appointments=${appointmentDetails.length}`,
        );

        summaries.push({
          professionalId: professional.id,
          professionalName: `${professional.firstName} ${professional.lastName}`,
          totalEarnings,
          pendingCommission,
          paidCommission,
          appointments: appointmentDetails,
        });
      } catch (error) {
        // If there's an error, still include the professional with empty data
        console.error(
          `Error getting commission summary for professional ${professional.id} (${professional.firstName} ${professional.lastName}):`,
          error,
        );
        console.log("Adding professional with zero values due to error");
        summaries.push({
          professionalId: professional.id,
          professionalName: `${professional.firstName} ${professional.lastName}`,
          totalEarnings: 0,
          pendingCommission: 0,
          paidCommission: 0,
          appointments: [],
        });
      }
    }

    console.log(`Returning ${summaries.length} commission summaries`);
    console.log(
      "Summary names:",
      summaries.map((s) => s.professionalName).join(", "),
    );

    return summaries;
  }

  /**
   * Get payroll report for a date range
   */
  async getPayrollReport(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{
    period: { start: Date; end: Date };
    totalPayroll: number;
    professionals: {
      id: string;
      name: string;
      totalHours: number;
      totalSales: number;
      commission: number;
    }[];
  }> {
    // Get all active professionals first
    const allProfessionals = await this.prisma.professional.findMany({
      where: {
        tenantId,
        isActive: true,
      },
    });

    const appointments = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        scheduledDate: {
          gte: startDate,
          lte: endDate,
        },
        status: "completed",
      },
      include: {
        professional: true,
      },
    });

    const professionalMap = new Map<
      string,
      {
        id: string;
        name: string;
        totalSales: number;
        commission: number;
      }
    >();

    // Initialize all active professionals with zero values
    for (const prof of allProfessionals) {
      professionalMap.set(prof.id, {
        id: prof.id,
        name: `${prof.firstName} ${prof.lastName}`,
        totalSales: 0,
        commission: 0,
      });
    }

    // Update with actual appointment data
    for (const apt of appointments) {
      const profId = apt.professionalId;
      const existing = professionalMap.get(profId);

      if (existing) {
        existing.totalSales += Number(apt.totalAmount);
        existing.commission += Number(apt.commissionAmount || 0);
        professionalMap.set(profId, existing);
      }
    }

    const professionals = Array.from(professionalMap.values());

    return {
      period: { start: startDate, end: endDate },
      totalPayroll: professionals.reduce((sum, p) => sum + p.commission, 0),
      professionals: professionals.map((p) => ({
        ...p,
        totalHours: 0, // Placeholder - would require time tracking
      })),
    };
  }

  /**
   * Get professional by user ID (for commission access)
   */
  async getProfessionalByUserId(userId: string, tenantId: string) {
    return this.prisma.professional.findFirst({
      where: { userId, tenantId },
      select: { id: true, firstName: true, lastName: true },
    });
  }
}
