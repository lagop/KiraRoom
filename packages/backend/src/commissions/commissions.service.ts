import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { PayCommissionDto } from "./dto/commission.dto";
import { effectiveCommissionRate, numberOrNull } from "./commission-rate";
import { appointmentKeptShares, roundCommission, saleLineAfterRefunds } from "./commission-refunds";

export interface CalculateCommissionDto {
  appointmentId: string;
  amount?: number;
  rate?: number;
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
    /** "sale": a service sold at the till without an appointment (PosSaleLine). */
    source?: "appointment" | "sale";
  }[];
}

/**
 * Commissions come from two places, on the same basis (the catalogue figure,
 * cents: Appointment.totalAmount, or a sale line's commissionBaseCents --
 * without the tax when the salon's prices are the base):
 *   - appointments: completed and paid, the appointment's professional;
 *   - services sold at the till without an appointment: the sale line names
 *     the professional who did it (pos.service.ts) and keeps the rate and
 *     amount worked out when it was sold.
 * What was refunded no longer earns a commission (commission-refunds.ts): a
 * sale line counts what is left of it after its refunds, an appointment the
 * share of its payments the salon kept.
 */
type SaleLineRow = {
  id: string;
  createdAt: Date;
  description: string;
  commissionBaseCents: number;
  commissionRate: unknown;
  commissionAmount: unknown;
  commissionPaid: boolean;
  professionalId: string | null;
  totalCents?: number;
  refundedCents?: number | null;
};

/** A line's commission and base after its refunds (commission-refunds.ts). */
function lineFigures(l: SaleLineRow, defaultRate: number) {
  const rate = effectiveCommissionRate(l.commissionRate, defaultRate);
  const commission = numberOrNull(l.commissionAmount) ?? (l.commissionBaseCents * rate) / 100;
  const after = saleLineAfterRefunds({
    commissionBaseCents: l.commissionBaseCents,
    commissionAmount: commission,
    totalCents: Number(l.totalCents ?? 0),
    refundedCents: l.refundedCents ?? 0,
  });
  return { rate, amount: after.baseCents, commission: after.commission, kept: after.kept };
}

@Injectable()
export class CommissionsService {
  constructor(private prisma: PrismaService) {}

  /** The till's walk-in service lines with a professional (none on a database without them). */
  private async saleLines(where: Record<string, unknown>): Promise<SaleLineRow[]> {
    const model = (this.prisma as any).posSaleLine;
    if (!model?.findMany) return [];
    return model.findMany({ where: { kind: "service", ...where }, orderBy: { createdAt: "desc" } });
  }

  private saleEntries(lines: SaleLineRow[], defaultRate: number): CommissionSummary["appointments"] {
    // A line given back in full earns nothing: it is not listed.
    return lines
      .map((l) => ({ l, f: lineFigures(l, defaultRate) }))
      .filter(({ f }) => f.kept > 0)
      .map(({ l, f }) => ({
        id: l.id,
        date: l.createdAt,
        clientName: "Venta en caja",
        serviceName: l.description,
        amount: f.amount,
        commissionRate: f.rate,
        commissionAmount: f.commission,
        paid: l.commissionPaid,
        source: "sale" as const,
      }));
  }

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
    // 0 is a rate: only a missing one falls through (commission-rate.ts).
    const rate = effectiveCommissionRate(
      dto.rate,
      appointment.commissionRate,
      appointment.professional.commissionRate,
    );

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

    const defaultRate = effectiveCommissionRate(professional.commissionRate);

    let totalCommission = 0;

    for (const appointment of appointments) {
      const rate = effectiveCommissionRate(appointment.commissionRate, defaultRate);
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

    const defaultRate = effectiveCommissionRate(professional.commissionRate);
    // Partly refunded visits count the share the salon kept (commission-refunds.ts).
    const kept = await appointmentKeptShares(this.prisma, tenantId, appointments.map((a) => a.id));

    let pendingCommission = 0;
    let paidCommission = 0;

    const appointmentDetails = appointments.map((apt) => {
      const rate = effectiveCommissionRate(apt.commissionRate, defaultRate);
      const share = kept.get(apt.id) ?? 1;
      const amount = Math.round(Number(apt.totalAmount) * share);
      const commissionAmount = roundCommission(
        (numberOrNull(apt.commissionAmount) ?? (Number(apt.totalAmount) * rate) / 100) * share,
      );

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

    const sales = this.saleEntries(
      await this.saleLines({ tenantId, professionalId, commissionPaid: false }),
      defaultRate,
    );
    for (const s of sales) pendingCommission += s.commissionAmount;
    const entries = [...appointmentDetails, ...sales];

    return {
      professionalId: professional.id,
      professionalName: `${professional.firstName} ${professional.lastName}`,
      totalEarnings: entries.reduce((sum, a) => sum + a.amount, 0),
      pendingCommission,
      paidCommission,
      appointments: entries,
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

    // What is paid is the commission after refunds, as the summary shows it.
    const kept = await appointmentKeptShares(this.prisma, tenantId, appointments.map((a) => a.id));
    let totalAmount = 0;
    for (const apt of appointments) {
      totalAmount += roundCommission(Number(apt.commissionAmount || 0) * (kept.get(apt.id) ?? 1));
    }

    const result = await this.prisma.appointment.updateMany({
      where: whereClause,
      data: {
        commissionPaid: true,
        commissionDate: new Date(),
      },
    });

    // The walk-in services of the till, by the same filters (ids, sale dates).
    let salesCount = 0;
    const lineModel = (this.prisma as any).posSaleLine;
    if (lineModel?.findMany) {
      const lineWhere: any = { tenantId, professionalId, kind: "service", commissionPaid: false };
      if (dto.appointmentIds && dto.appointmentIds.length > 0) lineWhere.id = { in: dto.appointmentIds };
      if (dto.startDate || dto.endDate) {
        lineWhere.createdAt = { ...(dto.startDate ? { gte: dto.startDate } : {}), ...(dto.endDate ? { lte: dto.endDate } : {}) };
      }
      const lines: SaleLineRow[] = await lineModel.findMany({ where: lineWhere });
      for (const l of lines) {
        const c = numberOrNull(l.commissionAmount) ?? 0;
        totalAmount += saleLineAfterRefunds({
          commissionBaseCents: l.commissionBaseCents,
          commissionAmount: c,
          totalCents: Number(l.totalCents ?? 0),
          refundedCents: l.refundedCents ?? 0,
        }).commission;
      }
      const paidLines = await lineModel.updateMany({
        where: lineWhere,
        data: { commissionPaid: true, commissionDate: new Date() },
      });
      salesCount = paidLines.count ?? 0;
    }

    return {
      count: result.count + salesCount,
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
        const defaultRate = effectiveCommissionRate(professional.commissionRate);

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
        const kept = await appointmentKeptShares(this.prisma, tenantId, appointments.map((a) => a.id));

        const appointmentDetails = appointments.map((apt) => {
          const rate = effectiveCommissionRate(apt.commissionRate, defaultRate);
          const share = kept.get(apt.id) ?? 1;
          const amount = Math.round(Number(apt.totalAmount) * share);
          const commissionAmount = roundCommission(
            (numberOrNull(apt.commissionAmount) ?? (Number(apt.totalAmount) * rate) / 100) * share,
          );

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

        const sales = this.saleEntries(
          await this.saleLines({ tenantId, professionalId: professional.id, commissionPaid: false }),
          defaultRate,
        );
        for (const s of sales) pendingCommission += s.commissionAmount;
        appointmentDetails.push(...sales);

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

    // Update with actual appointment data: what was refunded of a visit
    // counts neither as a sale nor for its commission (commission-refunds.ts).
    const kept = await appointmentKeptShares(this.prisma, tenantId, appointments.map((a) => a.id));
    for (const apt of appointments) {
      const profId = apt.professionalId;
      const existing = professionalMap.get(profId);
      const share = kept.get(apt.id) ?? 1;

      if (existing) {
        existing.totalSales += Math.round(Number(apt.totalAmount) * share);
        existing.commission += roundCommission(Number(apt.commissionAmount || 0) * share);
        professionalMap.set(profId, existing);
      }
    }

    // Walk-in services sold at the till in the period.
    for (const line of await this.saleLines({ tenantId, createdAt: { gte: startDate, lte: endDate } })) {
      const existing = line.professionalId ? professionalMap.get(line.professionalId) : undefined;
      if (existing) {
        const after = saleLineAfterRefunds({
          commissionBaseCents: line.commissionBaseCents,
          commissionAmount: numberOrNull(line.commissionAmount) ?? 0,
          totalCents: Number(line.totalCents ?? 0),
          refundedCents: line.refundedCents ?? 0,
        });
        existing.totalSales += after.baseCents;
        existing.commission += after.commission;
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
