import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { PayCommissionDto } from "./dto/commission.dto";
import { effectiveCommissionRate, numberOrNull } from "./commission-rate";
import { appointmentKeptShares, roundCommission, saleLineAfterRefunds } from "./commission-refunds";
import {
  REFUND_ADJUSTMENT_LABEL,
  appointmentSourceKey,
  clawedBackBySource,
  saleLineSourceKey,
} from "./commission-clawback";
import { CommissionPeriodFilters, commissionPeriodFilters, periodDay } from "./commission-period";
import { salonToday } from "../analytics/analytics-metrics";
import { safeTimeZone } from "../gift-cards/gift-card-expiry";

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
    /**
     * "sale": a service sold at the till without an appointment (PosSaleLine).
     * "refund_adjustment": commission taken back by a refund given after it
     * was paid ("Ajuste por devolución", commission-clawback.ts): negative,
     * settled by the next payout.
     */
    source?: "appointment" | "sale" | "refund_adjustment";
    /** refund_adjustment: the refund it comes from, and the service or line it corrects. */
    refundId?: string;
    description?: string;
  }[];
  /**
   * The salon day ("YYYY-MM-DD") the pending figure runs up to, today:
   * "Pagar" pays exactly this, whatever the payroll tab's dates.
   */
  pendingUpTo?: string;
}

/** 12345 (cents) -> "123,45 €", for the messages. */
function eurosFromCents(cents: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(Math.round(cents) / 100);
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
 * share of its payments the salon kept. A refund given after the commission
 * was paid takes it back with an adjustment (commission-clawback.ts): pending
 * in the summary until the next payout, in the payroll report of its own
 * period, never rewriting the paid one.
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

/** A refund adjustment as the payroll report lists it. */
export interface PayrollAdjustment {
  id: string;
  date: Date;
  refundId: string;
  /** Negative: the commission taken back. */
  amount: number;
  /** "Ajuste por devolución". */
  label: string;
}

@Injectable()
export class CommissionsService {
  private readonly logger = new Logger(CommissionsService.name);

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
   * The professional's refund adjustments not settled yet, as summary entries
   * ("Ajuste por devolución"): a negative commission, no amount of sales.
   */
  private async pendingAdjustmentEntries(
    tenantId: string,
    professionalId: string,
    filters: { createdAt?: { gte?: Date; lt?: Date }; id?: { in: string[] } } = {},
  ): Promise<CommissionSummary["appointments"]> {
    const model = (this.prisma as any).commissionAdjustment;
    if (!model?.findMany) return [];
    const rows: Array<{
      id: string;
      createdAt: Date;
      refundId: string;
      appointmentId: string | null;
      posSaleLineId: string | null;
      amount: unknown;
    }> = await model.findMany({
      where: { tenantId, professionalId, settled: false, ...filters },
      orderBy: { createdAt: "desc" },
    });
    if (rows.length === 0) return [];
    const aptIds = rows.map((r) => r.appointmentId).filter((id): id is string => !!id);
    const lineIds = rows.map((r) => r.posSaleLineId).filter((id): id is string => !!id);
    const lineModel = (this.prisma as any).posSaleLine;
    const [apts, lines]: [any[], any[]] = await Promise.all([
      aptIds.length
        ? this.prisma.appointment.findMany({
            where: { tenantId, id: { in: aptIds } },
            select: {
              id: true,
              serviceName: true,
              client: { select: { firstName: true, lastName: true } },
              service: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      lineIds.length && lineModel?.findMany
        ? lineModel.findMany({ where: { tenantId, id: { in: lineIds } }, select: { id: true, description: true } })
        : Promise.resolve([]),
    ]);
    const aptById = new Map(apts.map((a) => [a.id, a]));
    const lineById = new Map(lines.map((l) => [l.id, l]));
    return rows.map((r) => {
      const apt = r.appointmentId ? aptById.get(r.appointmentId) : undefined;
      const line = r.posSaleLineId ? lineById.get(r.posSaleLineId) : undefined;
      const what: string | undefined = apt ? (apt.serviceName ?? apt.service?.name) : line?.description;
      return {
        id: r.id,
        date: r.createdAt,
        clientName: apt?.client ? `${apt.client.firstName} ${apt.client.lastName}` : "Venta en caja",
        serviceName: what ? `${REFUND_ADJUSTMENT_LABEL}: ${what}` : REFUND_ADJUSTMENT_LABEL,
        amount: 0,
        commissionRate: 0,
        commissionAmount: roundCommission(numberOrNull(r.amount) ?? 0),
        paid: false,
        source: "refund_adjustment" as const,
        refundId: r.refundId,
        ...(what ? { description: what } : {}),
      };
    });
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
   * What a professional has pending, item by item, as the summary lists it
   * and "Pagar" pays it: completed and paid visits not paid out yet (their
   * commission after refunds), walk-in services sold at the till, and the
   * refund adjustments not settled ("Ajuste por devolución", negative).
   * Limited to the given dates (`scheduledDate` for visits, `createdAt` for
   * the rest) and ids, when given.
   */
  private async pendingItems(
    tenantId: string,
    professional: { id: string; commissionRate: unknown },
    filters: CommissionPeriodFilters & { ids?: string[] },
  ): Promise<{ entries: CommissionSummary["appointments"]; total: number }> {
    const ids = filters.ids && filters.ids.length > 0 ? { id: { in: filters.ids } } : {};
    const appointments = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        professionalId: professional.id,
        status: "completed",
        paymentStatus: "paid",
        commissionPaid: false,
        ...(filters.scheduledDate ? { scheduledDate: filters.scheduledDate } : {}),
        ...ids,
      },
      include: {
        client: true,
        service: true,
      },
      orderBy: {
        scheduledDate: "desc",
      },
    });

    const defaultRate = effectiveCommissionRate(professional.commissionRate as any);
    // Partly refunded visits count the share the salon kept (commission-refunds.ts).
    const kept = await appointmentKeptShares(this.prisma, tenantId, appointments.map((a) => a.id));
    const visits: CommissionSummary["appointments"] = appointments.map((apt: any) => {
      const rate = effectiveCommissionRate(apt.commissionRate, defaultRate);
      const share = kept.get(apt.id) ?? 1;
      return {
        id: apt.id,
        date: apt.scheduledDate,
        clientName: apt.client ? `${apt.client.firstName} ${apt.client.lastName}` : "Clienta",
        serviceName: apt.service?.name ?? apt.serviceName ?? "Servicio",
        amount: Math.round(Number(apt.totalAmount) * share),
        commissionRate: rate,
        commissionAmount: roundCommission(
          (numberOrNull(apt.commissionAmount) ?? (Number(apt.totalAmount) * rate) / 100) * share,
        ),
        paid: !!apt.commissionPaid,
        source: "appointment" as const,
      };
    });

    const sales = this.saleEntries(
      await this.saleLines({
        tenantId,
        professionalId: professional.id,
        commissionPaid: false,
        ...(filters.createdAt ? { createdAt: filters.createdAt } : {}),
        ...ids,
      }),
      defaultRate,
    );
    const adjustments = await this.pendingAdjustmentEntries(tenantId, professional.id, {
      ...(filters.createdAt ? { createdAt: filters.createdAt } : {}),
      ...ids,
    });

    const entries = [...visits, ...sales, ...adjustments];
    const total = roundCommission(entries.reduce((sum, e) => sum + (e.paid ? 0 : e.commissionAmount), 0));
    return { entries, total };
  }

  /** Everything up to the end of today on the salon's clock: what "Pagar" pays. */
  private upToToday(timeZone: string, now: Date): CommissionPeriodFilters & { day: string } {
    const day = salonToday(timeZone, now);
    return { ...commissionPeriodFilters(null, day, timeZone), day };
  }

  private toSummary(
    professional: { id: string; firstName: string; lastName: string },
    pending: { entries: CommissionSummary["appointments"]; total: number },
    upTo: string,
  ): CommissionSummary {
    return {
      professionalId: professional.id,
      professionalName: `${professional.firstName} ${professional.lastName}`,
      totalEarnings: pending.entries.reduce((sum, a) => sum + a.amount, 0),
      pendingCommission: pending.total,
      paidCommission: 0,
      pendingUpTo: upTo,
      appointments: pending.entries,
    };
  }

  /**
   * A professional's pending commission: everything not paid out yet up to
   * the end of today on the salon's clock, refund adjustments included. The
   * "Pagar" dialog shows this figure and payCommission pays exactly it.
   */
  async getCommissionSummary(
    tenantId: string,
    professionalId: string,
    now: Date = new Date(),
  ): Promise<CommissionSummary> {
    const professional = await this.prisma.professional.findFirst({
      where: { id: professionalId, tenantId },
    });

    if (!professional) {
      throw new NotFoundException("Professional not found");
    }

    const cutoff = this.upToToday(await this.salonTimeZone(tenantId), now);
    return this.toSummary(professional, await this.pendingItems(tenantId, professional, cutoff), cutoff.day);
  }

  /**
   * "Pagar": marks paid what is pending for the professional and returns
   * the amount.
   *
   * Without dates or ids -- what the summary's button sends -- it pays
   * everything pending up to the end of today on the salon's clock, refund
   * adjustments netted in: the same items and the same figure as the summary
   * (it used to take the payroll tab's date range, so the dialog said one
   * amount and a different one was paid). With `expectedAmount` (the figure
   * the dialog showed) it refuses with 409, paying nothing, if that is no
   * longer what is pending.
   *
   * With dates or ids (API callers), the same, limited to them. Exactly the
   * items counted are marked paid.
   */
  async payCommission(
    tenantId: string,
    professionalId: string,
    dto: PayCommissionDto,
    now: Date = new Date(),
  ): Promise<{ count: number; totalAmount: number }> {
    const professional = await this.prisma.professional.findFirst({
      where: { id: professionalId, tenantId },
    });
    if (!professional) {
      throw new NotFoundException("Professional not found");
    }

    const timeZone = await this.salonTimeZone(tenantId);
    // Both days included, whole salon days (commission-period.ts).
    const period =
      dto.startDate || dto.endDate
        ? commissionPeriodFilters(dto.startDate, dto.endDate, timeZone)
        : this.upToToday(timeZone, now);
    const pending = await this.pendingItems(tenantId, professional, {
      scheduledDate: period.scheduledDate,
      createdAt: period.createdAt,
      ids: dto.appointmentIds,
    });

    if (
      dto.expectedAmount !== undefined &&
      dto.expectedAmount !== null &&
      Math.abs(pending.total - Number(dto.expectedAmount)) > 0.005
    ) {
      throw new ConflictException(
        `Lo pendiente ha cambiado desde que abriste el aviso: ahora es ${eurosFromCents(pending.total)}. ` +
          "No se ha pagado nada. Revísalo y vuelve a pagar.",
      );
    }

    const idsOf = (source: string) => pending.entries.filter((e) => e.source === source).map((e) => e.id);
    const paidAt = new Date();
    let count = 0;

    const visitIds = idsOf("appointment");
    if (visitIds.length > 0) {
      const result = await this.prisma.appointment.updateMany({
        where: { tenantId, professionalId, id: { in: visitIds }, commissionPaid: false },
        data: { commissionPaid: true, commissionDate: paidAt },
      });
      count += result.count ?? 0;
    }

    const lineIds = idsOf("sale");
    const lineModel = (this.prisma as any).posSaleLine;
    if (lineIds.length > 0 && lineModel?.updateMany) {
      const result = await lineModel.updateMany({
        where: { tenantId, professionalId, kind: "service", id: { in: lineIds }, commissionPaid: false },
        data: { commissionPaid: true, commissionDate: paidAt },
      });
      count += result.count ?? 0;
    }

    // Refund adjustments not settled yet (commission-clawback.ts): netted into this payout.
    const adjustmentIds = idsOf("refund_adjustment");
    const adjustmentModel = (this.prisma as any).commissionAdjustment;
    if (adjustmentIds.length > 0 && adjustmentModel?.updateMany) {
      const result = await adjustmentModel.updateMany({
        where: { tenantId, professionalId, id: { in: adjustmentIds }, settled: false },
        data: { settled: true, settledAt: paidAt },
      });
      count += result.count ?? 0;
    }

    return { count, totalAmount: pending.total };
  }

  /**
   * Every active professional's pending commission (the Comisiones summary
   * tab), each as getCommissionSummary works it out.
   */
  async getAllCommissionSummaries(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<CommissionSummary[]> {
    const professionals = await this.prisma.professional.findMany({
      where: {
        tenantId,
        isActive: true,
      },
    });
    const cutoff = this.upToToday(await this.salonTimeZone(tenantId), now);

    const summaries: CommissionSummary[] = [];
    for (const professional of professionals) {
      try {
        summaries.push(this.toSummary(professional, await this.pendingItems(tenantId, professional, cutoff), cutoff.day));
      } catch (error) {
        // One professional's data failing does not hide the others.
        this.logger.error(`Commission summary failed for professional ${professional.id}: ${(error as Error).message}`);
        summaries.push({
          professionalId: professional.id,
          professionalName: `${professional.firstName} ${professional.lastName}`,
          totalEarnings: 0,
          pendingCommission: 0,
          paidCommission: 0,
          pendingUpTo: cutoff.day,
          appointments: [],
        });
      }
    }
    return summaries;
  }

  /**
   * Get payroll report for a date range
   */
  async getPayrollReport(
    tenantId: string,
    startDate: Date | string,
    endDate: Date | string,
  ): Promise<{
    /** The calendar days asked for ("YYYY-MM-DD"), both included. */
    period: { start: string; end: string };
    totalPayroll: number;
    professionals: {
      id: string;
      name: string;
      totalHours: number;
      totalSales: number;
      /** Net: what the period's work earned, plus its refund adjustments (negative). */
      commission: number;
      /** "Ajuste por devolución": the period's refund adjustments, summed (0 or negative). */
      refundAdjustments: number;
      adjustments: PayrollAdjustment[];
    }[];
  }> {
    // Both days included, whole salon days (commission-period.ts).
    const start = periodDay(startDate);
    const end = periodDay(endDate);
    if (!start || !end) throw new BadRequestException("startDate and endDate must be dates (YYYY-MM-DD)");
    const range = commissionPeriodFilters(start, end, await this.salonTimeZone(tenantId));
    const scheduledDate = range.scheduledDate!;
    const createdAt = range.createdAt!;

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
        scheduledDate,
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
        refundAdjustments: number;
        adjustments: PayrollAdjustment[];
      }
    >();

    // Initialize all active professionals with zero values
    for (const prof of allProfessionals) {
      professionalMap.set(prof.id, {
        id: prof.id,
        name: `${prof.firstName} ${prof.lastName}`,
        totalSales: 0,
        commission: 0,
        refundAdjustments: 0,
        adjustments: [],
      });
    }

    // Update with actual appointment data: what was refunded of a visit
    // counts neither as a sale nor for its commission (commission-refunds.ts).
    // A refund given after the commission was paid does not rewrite this
    // period: what its adjustment took back is added back here and counted
    // in the period the adjustment was recorded in (commission-clawback.ts).
    const kept = await appointmentKeptShares(this.prisma, tenantId, appointments.map((a) => a.id));
    const periodLines = await this.saleLines({ tenantId, createdAt });
    const clawedBack = await clawedBackBySource(this.prisma, tenantId, {
      appointmentIds: appointments.filter((a) => a.commissionPaid).map((a) => a.id),
      lineIds: periodLines.filter((l) => l.commissionPaid).map((l) => l.id),
    });
    for (const apt of appointments) {
      const profId = apt.professionalId;
      const existing = professionalMap.get(profId);
      const share = kept.get(apt.id) ?? 1;

      if (existing) {
        existing.totalSales += Math.round(Number(apt.totalAmount) * share);
        existing.commission += roundCommission(Number(apt.commissionAmount || 0) * share);
        if (apt.commissionPaid) existing.commission += clawedBack.get(appointmentSourceKey(apt.id)) ?? 0;
        professionalMap.set(profId, existing);
      }
    }

    // Walk-in services sold at the till in the period.
    for (const line of periodLines) {
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
        if (line.commissionPaid) existing.commission += clawedBack.get(saleLineSourceKey(line.id)) ?? 0;
      }
    }

    // "Ajuste por devolución": the refund adjustments recorded in the period.
    const adjustmentModel = (this.prisma as any).commissionAdjustment;
    if (adjustmentModel?.findMany) {
      const rows: Array<{ id: string; createdAt: Date; refundId: string; professionalId: string; amount: unknown }> =
        await adjustmentModel.findMany({
          where: { tenantId, createdAt },
          orderBy: { createdAt: "asc" },
        });
      for (const r of rows) {
        const existing = professionalMap.get(r.professionalId);
        if (!existing) continue;
        const amount = roundCommission(numberOrNull(r.amount) ?? 0);
        existing.refundAdjustments = roundCommission(existing.refundAdjustments + amount);
        existing.commission += amount;
        existing.adjustments.push({ id: r.id, date: r.createdAt, refundId: r.refundId, amount, label: REFUND_ADJUSTMENT_LABEL });
      }
    }

    const professionals = Array.from(professionalMap.values()).map((p) => ({
      ...p,
      commission: roundCommission(p.commission),
    }));

    return {
      period: start <= end ? { start, end } : { start: end, end: start },
      totalPayroll: roundCommission(professionals.reduce((sum, p) => sum + p.commission, 0)),
      professionals: professionals.map((p) => ({
        ...p,
        totalHours: 0, // Placeholder - would require time tracking
      })),
    };
  }

  /** The salon's timezone, for cutting periods at its midnight. */
  private async salonTimeZone(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    return safeTimeZone(tenant?.timezone);
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
