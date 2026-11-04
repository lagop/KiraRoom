import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import type { UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { AuditLogService } from "../saas/audit-log.service";
import { csvNumberCell, csvTextCell } from "../common/csv-cell";
import { PayCommissionDto, UpdateCommissionSettingsDto } from "./dto/commission.dto";
import { effectiveCommissionRate, numberOrNull } from "./commission-rate";
import { appointmentKeptShares, roundCommission, saleLineAfterRefunds } from "./commission-refunds";
import {
  REFUND_ADJUSTMENT_LABEL,
  appointmentSourceKey,
  clawedBackBySource,
  saleLineSourceKey,
} from "./commission-clawback";
import { CommissionPeriodFilters, commissionPeriodFilters, periodDay } from "./commission-period";
import { appointmentCommission, commissionCents } from "./appointment-commission";
import { lockProfessionalCommissions } from "./commission-lock";
import { CommissionBase, CommissionTerms, commissionTermsOf } from "./commission-terms";
import { salonToday } from "../analytics/analytics-metrics";
import { safeTimeZone } from "../gift-cards/gift-card-expiry";

/** The Prisma client or a transaction on it. */
type Db = any;

/** Who does it, for the audit log. */
export interface CommissionActor {
  id: string;
  role: UserRole | string;
}

export interface CommissionEntry {
  id: string;
  date: Date;
  clientName: string;
  serviceName: string;
  amount: number;
  commissionRate: number;
  commissionAmount: number;
  paid: boolean;
  /**
   * "sale": a service or a product sold at the till without an appointment
   * (PosSaleLine, `kind` says which).
   * "refund_adjustment": commission taken back by a refund given after it
   * was paid ("Ajuste por devolución", commission-clawback.ts): negative,
   * settled by the next payout.
   */
  source?: "appointment" | "sale" | "refund_adjustment";
  /** "sale": a service or a product. */
  kind?: "service" | "product";
  /** refund_adjustment: the refund it comes from, and the service or line it corrects. */
  refundId?: string;
  description?: string;
}

export interface CommissionSummary {
  /** null: GET /commissions/me for a user with no professional profile. */
  professionalId: string | null;
  professionalName: string;
  /** false: the professional was deactivated ("De baja") and still has something pending. */
  isActive?: boolean;
  totalEarnings: number;
  pendingCommission: number;
  /** What the payouts of this month (salon calendar, to date) paid, undone ones left out. */
  paidCommission: number;
  /** The month `paidCommission` covers ("YYYY-MM-DD", both included). */
  paidPeriod?: { start: string; end: string };
  appointments: CommissionEntry[];
  /**
   * The salon day ("YYYY-MM-DD") the pending figure runs up to: today, or
   * the "Pagar hasta" day asked for. "Pagar" pays exactly this.
   */
  pendingUpTo?: string;
}

/** A payout as the "Pagos" tab lists it. */
export interface PayoutView {
  id: string;
  createdAt: Date;
  professionalId: string;
  professionalName: string;
  amountCents: number;
  itemCount: number;
  /** "YYYY-MM-DD", or null when paid by ids. */
  upTo: string | null;
  createdByName: string | null;
  undoneAt: Date | null;
  undoneByName: string | null;
  /** The latest payout of its professional not undone: "Deshacer último pago" applies. */
  canUndo: boolean;
}

/** What a payout marked paid, stored on it (CommissionPayout.items). */
interface PayoutItems {
  appointments: Array<{
    id: string;
    rate: number;
    amount: number;
    /** What the visit stored before the payout, put back by "Deshacer". */
    prevRate: number | null;
    prevAmount: number | null;
  }>;
  lines: string[];
  adjustments: string[];
}

/** 12345 (cents) -> "123,45 €", for the messages. */
function eurosFromCents(cents: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(Math.round(cents) / 100);
}

/** CSV rows end with CR LF, as Excel writes them. */
const CRLF = String.fromCharCode(13, 10);

/** 12345 (cents) -> "123,45", a CSV number cell. */
function csvEuros(cents: number): string {
  return csvNumberCell((Math.round(cents) / 100).toFixed(2).replace(".", ","));
}

/** A Date column of a day (stored at 00:00 UTC) as "YYYY-MM-DD". */
function dayOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return periodDay(value instanceof Date ? value : String(value));
}

/**
 * Commissions come from two places, on the same basis (the salon's
 * "Comisión sobre": the price with or without the tax, commission-terms.ts):
 *   - appointments: completed and paid, the appointment's professional;
 *   - services and products sold at the till without an appointment: the
 *     sale line names the professional who did or sold it (pos.service.ts)
 *     and keeps the base, rate and amount worked out when it was sold.
 * What was refunded no longer earns a commission (commission-refunds.ts): a
 * sale line counts what is left of it after its refunds, an appointment the
 * share of its payments the salon kept. A refund given after the commission
 * was paid takes it back with an adjustment (commission-clawback.ts): pending
 * in the summary until the next payout, in the payroll report of its own
 * period, never rewriting the paid one.
 *
 * Each "Pagar" writes a CommissionPayout with the items it marked paid: the
 * "Pagado" figures come from the payouts, the "Pagos" tab lists them, and
 * "Deshacer último pago" unmarks exactly the items of a professional's latest
 * payout.
 */
type SaleLineRow = {
  id: string;
  createdAt: Date;
  kind?: string;
  description: string;
  commissionBaseCents: number;
  commissionRate: unknown;
  commissionAmount: unknown;
  commissionPaid: boolean;
  professionalId: string | null;
  totalCents?: number;
  refundedCents?: number | null;
};

/** The till line kinds that earn a commission. */
export const COMMISSION_LINE_KINDS = ["service", "product"];

/** A line's commission and base after its refunds (commission-refunds.ts). */
function lineFigures(l: SaleLineRow, defaultRate: number) {
  const rate = effectiveCommissionRate(l.commissionRate, defaultRate);
  const commission = numberOrNull(l.commissionAmount) ?? commissionCents(l.commissionBaseCents, rate);
  const after = saleLineAfterRefunds({
    commissionBaseCents: l.commissionBaseCents,
    commissionAmount: commission,
    totalCents: Number(l.totalCents ?? 0),
    refundedCents: l.refundedCents ?? 0,
  });
  return { rate, amount: after.baseCents, commission: after.commission, kept: after.kept };
}

/** A professional's own rates, with the salon's defaults behind them. */
function professionalRates(professional: any, terms: CommissionTerms) {
  return {
    service: effectiveCommissionRate(professional?.commissionRate, terms.defaultRate),
    product: effectiveCommissionRate(professional?.productCommissionRate, terms.productDefaultRate),
  };
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

export interface PayrollReport {
  /** The calendar days asked for ("YYYY-MM-DD"), both included. */
  period: { start: string; end: string };
  totalPayroll: number;
  professionals: {
    id: string;
    name: string;
    /** false: deactivated ("De baja"), listed for their work in the period. */
    isActive: boolean;
    totalHours: number;
    totalSales: number;
    /** Of totalSales, the products sold at the till. */
    productSales: number;
    /** Net: what the period's work earned, plus its refund adjustments (negative). */
    commission: number;
    /** "Ajuste por devolución": the period's refund adjustments, summed (0 or negative). */
    refundAdjustments: number;
    adjustments: PayrollAdjustment[];
    /** What the period's payouts paid (by payout date), undone ones left out. */
    paid: number;
  }[];
  /** "Servicios sin profesional": walk-in services sold in the period with nobody named. */
  unassignedServices: { count: number; totalSales: number };
}

export interface CommissionSettings {
  defaultRate: number;
  productDefaultRate: number;
  base: CommissionBase;
  /** Whether the salon's prices include the tax (Ajustes > Facturación), for the hint. */
  pricesIncludeTax: boolean;
}

@Injectable()
export class CommissionsService {
  private readonly logger = new Logger(CommissionsService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  /** The till's walk-in service and product lines (none on a database without them). */
  private async saleLines(where: Record<string, unknown>, db: Db = this.prisma): Promise<SaleLineRow[]> {
    const model = db.posSaleLine;
    if (!model?.findMany) return [];
    return model.findMany({ where: { kind: { in: COMMISSION_LINE_KINDS }, ...where }, orderBy: { createdAt: "desc" } });
  }

  private saleEntries(lines: SaleLineRow[], rates: { service: number; product: number }): CommissionEntry[] {
    // A line given back in full earns nothing: it is not listed.
    return lines
      .map((l) => ({ l, f: lineFigures(l, l.kind === "product" ? rates.product : rates.service) }))
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
        kind: l.kind === "product" ? ("product" as const) : ("service" as const),
      }));
  }

  /**
   * A professional's refund adjustments, as summary entries ("Ajuste por
   * devolución"): a negative commission, no amount of sales. By default the
   * ones not settled yet.
   */
  private async adjustmentEntries(
    tenantId: string,
    professionalId: string,
    filters: { createdAt?: { gte?: Date; lt?: Date }; id?: { in: string[] }; settled?: boolean } = {},
    db: Db = this.prisma,
  ): Promise<CommissionEntry[]> {
    const model = db.commissionAdjustment;
    if (!model?.findMany) return [];
    const rows: Array<{
      id: string;
      createdAt: Date;
      refundId: string;
      appointmentId: string | null;
      posSaleLineId: string | null;
      amount: unknown;
      settled?: boolean;
    }> = await model.findMany({
      where: { tenantId, professionalId, settled: false, ...filters },
      orderBy: { createdAt: "desc" },
    });
    if (rows.length === 0) return [];
    const aptIds = rows.map((r) => r.appointmentId).filter((id): id is string => !!id);
    const lineIds = rows.map((r) => r.posSaleLineId).filter((id): id is string => !!id);
    const lineModel = db.posSaleLine;
    const [apts, lines]: [any[], any[]] = await Promise.all([
      aptIds.length
        ? db.appointment.findMany({
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
        paid: r.settled === true,
        source: "refund_adjustment" as const,
        refundId: r.refundId,
        ...(what ? { description: what } : {}),
      };
    });
  }

  /**
   * What a professional has pending, item by item, as the summary lists it
   * and "Pagar" pays it: completed and paid visits not paid out yet (their
   * commission after refunds), walk-in services and products sold at the
   * till, and the refund adjustments not settled ("Ajuste por devolución",
   * negative). Limited to the given dates (`scheduledDate` for visits,
   * `createdAt` for the rest) and ids, when given.
   *
   * A visit's commission is its snapshot (appointment-commission.ts): its
   * rate x its base while it is not paid out, so a stored 0 left by the old
   * column default is never taken for a commission of 0. `snapshots` holds,
   * per visit, the full commission (before refunds) and the rate that
   * "Pagar" stores on it, and what the visit stored before.
   */
  private async pendingItems(
    tenantId: string,
    professional: { id: string; commissionRate: unknown; productCommissionRate?: unknown },
    filters: CommissionPeriodFilters & { ids?: string[] },
    db: Db = this.prisma,
    terms?: CommissionTerms,
  ): Promise<{
    entries: CommissionEntry[];
    total: number;
    snapshots: Map<string, { rate: number; amount: number; prevRate: number | null; prevAmount: number | null }>;
  }> {
    const salonTerms = terms ?? (await commissionTermsOf(db, tenantId));
    const ids = filters.ids && filters.ids.length > 0 ? { id: { in: filters.ids } } : {};
    const appointments = await db.appointment.findMany({
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

    // Partly refunded visits count the share the salon kept (commission-refunds.ts).
    const kept = await appointmentKeptShares(db, tenantId, appointments.map((a: any) => a.id));
    const snapshots = new Map<string, { rate: number; amount: number; prevRate: number | null; prevAmount: number | null }>();
    const visits: CommissionEntry[] = appointments.map((apt: any) => {
      const snapshot = appointmentCommission(apt, professional.commissionRate, salonTerms);
      snapshots.set(apt.id, {
        ...snapshot,
        prevRate: numberOrNull(apt.commissionRate),
        prevAmount: numberOrNull(apt.commissionAmount),
      });
      const share = kept.get(apt.id) ?? 1;
      return {
        id: apt.id,
        date: apt.scheduledDate,
        clientName: apt.client ? `${apt.client.firstName} ${apt.client.lastName}` : "Clienta",
        serviceName: apt.service?.name ?? apt.serviceName ?? "Servicio",
        amount: Math.round(Number(apt.totalAmount) * share),
        commissionRate: snapshot.rate,
        commissionAmount: roundCommission(snapshot.amount * share),
        paid: !!apt.commissionPaid,
        source: "appointment" as const,
      };
    });

    const sales = this.saleEntries(
      await this.saleLines(
        {
          tenantId,
          professionalId: professional.id,
          commissionPaid: false,
          ...(filters.createdAt ? { createdAt: filters.createdAt } : {}),
          ...ids,
        },
        db,
      ),
      professionalRates(professional, salonTerms),
    )
      // A product that earns nothing (the salon's products at 0 %) is not
      // something to pay: it is not listed (the payroll report counts its sale).
      .filter((e) => e.kind !== "product" || e.commissionAmount !== 0);
    const adjustments = await this.adjustmentEntries(
      tenantId,
      professional.id,
      {
        ...(filters.createdAt ? { createdAt: filters.createdAt } : {}),
        ...ids,
      },
      db,
    );

    const entries = [...visits, ...sales, ...adjustments];
    // Each entry is whole cents already: the total adds up integers.
    const total = entries.reduce((sum, e) => sum + (e.paid ? 0 : e.commissionAmount), 0);
    return { entries, total, snapshots };
  }

  /**
   * Everything up to the end of a salon day: today by default (what "Pagar"
   * pays), or the "Pagar hasta" day asked for.
   */
  private upTo(timeZone: string, now: Date, day?: string | null): CommissionPeriodFilters & { day: string } {
    const until = day ?? salonToday(timeZone, now);
    return { ...commissionPeriodFilters(null, until, timeZone), day: until };
  }

  /** This month on the salon's calendar, to today: what "Pagado" covers. */
  private monthToDate(timeZone: string, now: Date): { start: string; end: string; createdAt: { gte?: Date; lt?: Date } } {
    const end = salonToday(timeZone, now);
    const start = `${end.slice(0, 8)}01`;
    return { start, end, createdAt: commissionPeriodFilters(start, end, timeZone).createdAt ?? {} };
  }

  /** What the payouts (not undone) in a range paid, per professional. */
  private async paidByProfessional(
    tenantId: string,
    createdAt: { gte?: Date; lt?: Date },
    professionalId?: string,
  ): Promise<Map<string, number>> {
    const model = (this.prisma as any).commissionPayout;
    const out = new Map<string, number>();
    if (!model?.findMany) return out;
    const rows: Array<{ professionalId: string; amountCents: number }> = await model.findMany({
      where: { tenantId, undoneAt: null, createdAt, ...(professionalId ? { professionalId } : {}) },
      select: { professionalId: true, amountCents: true },
    });
    for (const r of rows ?? []) out.set(r.professionalId, (out.get(r.professionalId) ?? 0) + Number(r.amountCents));
    return out;
  }

  private toSummary(
    professional: { id: string; firstName: string; lastName: string; isActive?: boolean | null },
    pending: { entries: CommissionEntry[]; total: number },
    upTo: string,
    paid: { amount: number; period: { start: string; end: string } },
  ): CommissionSummary {
    return {
      professionalId: professional.id,
      professionalName: `${professional.firstName} ${professional.lastName}`,
      isActive: professional.isActive !== false,
      totalEarnings: pending.entries.reduce((sum, a) => sum + a.amount, 0),
      pendingCommission: pending.total,
      paidCommission: paid.amount,
      paidPeriod: paid.period,
      pendingUpTo: upTo,
      appointments: pending.entries,
    };
  }

  /**
   * A professional's pending commission: everything not paid out yet up to
   * the end of today on the salon's clock (or of `upTo`, "Pagar hasta"),
   * refund adjustments included. The "Pagar" dialog shows this figure and
   * payCommission pays exactly it.
   */
  async getCommissionSummary(
    tenantId: string,
    professionalId: string,
    now: Date = new Date(),
    upTo?: string | null,
  ): Promise<CommissionSummary> {
    const professional = await this.prisma.professional.findFirst({
      where: { id: professionalId, tenantId },
    });

    if (!professional) {
      throw new NotFoundException("Profesional no encontrado");
    }

    const day = upTo === undefined || upTo === null || upTo === "" ? null : periodDay(upTo);
    if (upTo && !day) throw new BadRequestException("Indica la fecha «Pagar hasta» como AAAA-MM-DD.");
    const timeZone = await this.salonTimeZone(tenantId);
    const cutoff = this.upTo(timeZone, now, day);
    const month = this.monthToDate(timeZone, now);
    const paid = await this.paidByProfessional(tenantId, month.createdAt, professional.id);
    return this.toSummary(professional, await this.pendingItems(tenantId, professional, cutoff), cutoff.day, {
      amount: paid.get(professional.id) ?? 0,
      period: { start: month.start, end: month.end },
    });
  }

  /**
   * GET /commissions/me: the signed-in staff member's own summary, in the
   * same shape as a professional's, with their recent payouts. A user with
   * no professional profile gets an empty one.
   */
  async getMyCommissions(
    tenantId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<CommissionSummary & { payouts: PayoutView[] }> {
    const professional = await this.getProfessionalByUserId(userId, tenantId);
    if (!professional) {
      const timeZone = await this.salonTimeZone(tenantId);
      const month = this.monthToDate(timeZone, now);
      return {
        professionalId: null,
        professionalName: "",
        isActive: true,
        totalEarnings: 0,
        pendingCommission: 0,
        paidCommission: 0,
        paidPeriod: { start: month.start, end: month.end },
        pendingUpTo: month.end,
        appointments: [],
        payouts: [],
      };
    }
    const summary = await this.getCommissionSummary(tenantId, professional.id, now);
    const payouts = (await this.listPayouts(tenantId, { professionalId: professional.id, limit: 24 })).filter(
      (p) => !p.undoneAt,
    );
    // Staff see their payouts, not who in the salon made them nor what can be undone.
    return {
      ...summary,
      payouts: payouts.map((p) => ({ ...p, createdByName: null, undoneByName: null, canUndo: false })),
    };
  }

  /**
   * "Pagar": marks paid what is pending for the professional, records the
   * payout (CommissionPayout, with the items it marked) and returns the
   * amount.
   *
   * Without dates or ids it pays everything pending up to the end of today
   * on the salon's clock, refund adjustments netted in: the same items and
   * the same figure as the summary. With `endDate` ("Pagar hasta"), up to
   * the end of that salon day: the dialog re-reads the summary up to it and
   * sends the figure it shows. With `expectedAmount` (the figure the dialog
   * showed) it refuses with 409, paying nothing, if that is no longer what
   * is pending.
   *
   * With `startDate` or ids (API callers), the same, limited to them. Exactly
   * the items counted are marked paid.
   *
   * All of it in one transaction, under the professional's commission lock
   * (commission-lock.ts), the one a refund's clawback takes too: two "Pagar"
   * at once run one after the other (the second finds the figure changed, or
   * nothing left, instead of a second success), and a refund lands either
   * before the payout or after it. Every item counted must be marked, or
   * nothing is (409). Each visit keeps the commission it was paid with: its
   * rate and full amount (appointment-commission.ts).
   */
  async payCommission(
    tenantId: string,
    professionalId: string,
    dto: PayCommissionDto,
    now: Date = new Date(),
    actor?: CommissionActor,
  ): Promise<{ count: number; totalAmount: number; payoutId: string | null }> {
    const professional = await this.prisma.professional.findFirst({
      where: { id: professionalId, tenantId },
    });
    if (!professional) {
      throw new NotFoundException("Profesional no encontrado");
    }

    const timeZone = await this.salonTimeZone(tenantId);
    // Both days included, whole salon days (commission-period.ts).
    const period = dto.startDate
      ? { ...commissionPeriodFilters(dto.startDate, dto.endDate, timeZone), day: periodDay(dto.endDate ?? null) }
      : this.upTo(timeZone, now, periodDay(dto.endDate ?? null));

    return this.prisma.$transaction(
      async (tx: Db) => {
        await lockProfessionalCommissions(tx, tenantId, [professionalId]);
        const pending = await this.pendingItems(
          tenantId,
          professional,
          {
            scheduledDate: period.scheduledDate,
            createdAt: period.createdAt,
            ids: dto.appointmentIds,
          },
          tx,
        );

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

        // Visits, grouped by the commission they are paid with (stored on them).
        const groups = new Map<string, { rate: number; amount: number; ids: string[] }>();
        const items: PayoutItems = { appointments: [], lines: [], adjustments: [] };
        for (const id of idsOf("appointment")) {
          const s = pending.snapshots.get(id)!;
          items.appointments.push({ id, ...s });
          const key = `${s.rate}|${s.amount}`;
          const group = groups.get(key) ?? { rate: s.rate, amount: s.amount, ids: [] };
          group.ids.push(id);
          groups.set(key, group);
        }
        for (const group of groups.values()) {
          const result = await tx.appointment.updateMany({
            where: { tenantId, professionalId, id: { in: group.ids }, commissionPaid: false },
            data: {
              commissionPaid: true,
              commissionDate: paidAt,
              commissionRate: group.rate,
              commissionAmount: group.amount,
            },
          });
          count += result?.count ?? 0;
        }

        const lineIds = idsOf("sale");
        if (lineIds.length > 0 && tx.posSaleLine?.updateMany) {
          const result = await tx.posSaleLine.updateMany({
            where: {
              tenantId,
              professionalId,
              kind: { in: COMMISSION_LINE_KINDS },
              id: { in: lineIds },
              commissionPaid: false,
            },
            data: { commissionPaid: true, commissionDate: paidAt },
          });
          count += result?.count ?? 0;
          items.lines = lineIds;
        }

        // Refund adjustments not settled yet (commission-clawback.ts): netted into this payout.
        const adjustmentIds = idsOf("refund_adjustment");
        if (adjustmentIds.length > 0 && tx.commissionAdjustment?.updateMany) {
          const result = await tx.commissionAdjustment.updateMany({
            where: { tenantId, professionalId, id: { in: adjustmentIds }, settled: false },
            data: { settled: true, settledAt: paidAt },
          });
          count += result?.count ?? 0;
          items.adjustments = adjustmentIds;
        }

        if (count !== pending.entries.length) {
          // Someone else paid or changed an item meanwhile: all of it is rolled back.
          throw new ConflictException(
            "Lo pendiente ha cambiado mientras se pagaba. No se ha pagado nada. Recarga y vuelve a pagar.",
          );
        }

        // Nothing pending: nothing paid, no payout recorded.
        if (count === 0 || !tx.commissionPayout?.create) {
          return { count, totalAmount: pending.total, payoutId: null };
        }
        const payout = await tx.commissionPayout.create({
          data: {
            tenantId,
            professionalId,
            amountCents: Math.round(pending.total),
            itemCount: count,
            upTo: period.day ? new Date(`${period.day}T00:00:00.000Z`) : null,
            items: items as any,
            createdById: actor?.id ?? null,
            createdAt: paidAt,
          },
          select: { id: true },
        });
        await this.audit(tx, "commission.payout.created", tenantId, actor, {
          payoutId: payout.id,
          professionalId,
          amountCents: Math.round(pending.total),
          itemCount: count,
          upTo: period.day ?? null,
        });
        return { count, totalAmount: pending.total, payoutId: payout.id };
      },
      { timeout: 20_000 },
    );
  }

  /**
   * "Deshacer último pago": unmarks exactly the items a payout marked paid,
   * puts back what each visit stored before it, re-opens the refund
   * adjustments it settled, and marks the payout undone (kept in the
   * history). Only the latest payout of a professional that is not undone
   * can be undone: an older one may share items with the ones after it.
   *
   * A refund given after the payout took back part of its items with an
   * adjustment (commission-clawback.ts); once the items are pending again
   * their pending figure already counts that refund, so those adjustments,
   * still unsettled (no later payout exists), are removed. Audit-logged, in
   * the same transaction, under the professional's commission lock.
   */
  async undoPayout(
    tenantId: string,
    payoutId: string,
    actor?: CommissionActor,
  ): Promise<{ payoutId: string; professionalId: string; amountCents: number; itemCount: number }> {
    const model = (this.prisma as any).commissionPayout;
    const found = model?.findFirst ? await model.findFirst({ where: { id: payoutId, tenantId } }) : null;
    if (!found) throw new NotFoundException("Pago no encontrado");

    return this.prisma.$transaction(
      async (tx: Db) => {
        await lockProfessionalCommissions(tx, tenantId, [found.professionalId]);
        const payout = await tx.commissionPayout.findFirst({ where: { id: payoutId, tenantId } });
        if (!payout || payout.undoneAt) throw new ConflictException("Este pago ya se ha deshecho.");
        const latest = await tx.commissionPayout.findFirst({
          where: { tenantId, professionalId: payout.professionalId, undoneAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
        });
        if (latest?.id !== payout.id) {
          throw new ConflictException(
            "Solo se puede deshacer el último pago de cada profesional. Deshaz primero los posteriores.",
          );
        }

        const items = (payout.items ?? {}) as Partial<PayoutItems>;
        const professionalId: string = payout.professionalId;
        const counts = { appointments: 0, lines: 0, adjustments: 0, removedAdjustments: 0 };

        // Visits: back to pending, with what they stored before the payout.
        const groups = new Map<string, { prevRate: number | null; prevAmount: number | null; ids: string[] }>();
        for (const a of items.appointments ?? []) {
          const key = `${a.prevRate}|${a.prevAmount}`;
          const group = groups.get(key) ?? { prevRate: a.prevRate ?? null, prevAmount: a.prevAmount ?? null, ids: [] };
          group.ids.push(a.id);
          groups.set(key, group);
        }
        for (const group of groups.values()) {
          const result = await tx.appointment.updateMany({
            where: { tenantId, professionalId, id: { in: group.ids }, commissionPaid: true },
            data: {
              commissionPaid: false,
              commissionDate: null,
              commissionRate: group.prevRate,
              commissionAmount: group.prevAmount,
            },
          });
          counts.appointments += result?.count ?? 0;
        }
        const lineIds = items.lines ?? [];
        if (lineIds.length > 0) {
          const result = await tx.posSaleLine.updateMany({
            where: { tenantId, professionalId, id: { in: lineIds }, commissionPaid: true },
            data: { commissionPaid: false, commissionDate: null },
          });
          counts.lines = result?.count ?? 0;
        }
        const adjustmentIds = items.adjustments ?? [];
        if (adjustmentIds.length > 0) {
          const result = await tx.commissionAdjustment.updateMany({
            where: { tenantId, professionalId, id: { in: adjustmentIds }, settled: true },
            data: { settled: false, settledAt: null },
          });
          counts.adjustments = result?.count ?? 0;
        }

        // Clawbacks of refunds given after the payout on its own items.
        const sourceKeys = [
          ...(items.appointments ?? []).map((a) => appointmentSourceKey(a.id)),
          ...lineIds.map(saleLineSourceKey),
        ];
        let removed: Array<{ id: string; refundId: string; sourceKey: string; amount: unknown }> = [];
        if (sourceKeys.length > 0) {
          const where = {
            tenantId,
            professionalId,
            sourceKey: { in: sourceKeys },
            settled: false,
            createdAt: { gte: payout.createdAt },
            ...(adjustmentIds.length > 0 ? { id: { notIn: adjustmentIds } } : {}),
          };
          removed = await tx.commissionAdjustment.findMany({
            where,
            select: { id: true, refundId: true, sourceKey: true, amount: true },
          });
          if (removed.length > 0) {
            await tx.commissionAdjustment.deleteMany({ where: { tenantId, id: { in: removed.map((r) => r.id) } } });
            counts.removedAdjustments = removed.length;
          }
        }

        await tx.commissionPayout.update({
          where: { id: payout.id },
          data: { undoneAt: new Date(), undoneById: actor?.id ?? null },
        });
        await this.audit(tx, "commission.payout.undone", tenantId, actor, {
          payoutId: payout.id,
          professionalId,
          amountCents: payout.amountCents,
          itemCount: payout.itemCount,
          upTo: dayOf(payout.upTo),
          unmarked: counts,
          removedAdjustments: removed.map((r) => ({
            id: r.id,
            refundId: r.refundId,
            sourceKey: r.sourceKey,
            amount: numberOrNull(r.amount),
          })),
        });
        return { payoutId: payout.id, professionalId, amountCents: payout.amountCents, itemCount: payout.itemCount };
      },
      { timeout: 20_000 },
    );
  }

  /** The "Pagos" tab: the salon's payouts, newest first, with which can be undone. */
  async listPayouts(
    tenantId: string,
    options: { professionalId?: string; limit?: number } = {},
  ): Promise<PayoutView[]> {
    const model = (this.prisma as any).commissionPayout;
    if (!model?.findMany) return [];
    const rows: any[] = await model.findMany({
      where: { tenantId, ...(options.professionalId ? { professionalId: options.professionalId } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    });
    if (rows.length === 0) return [];
    const profIds = [...new Set(rows.map((r) => r.professionalId))];
    const userIds = [...new Set(rows.flatMap((r) => [r.createdById, r.undoneById]).filter((id): id is string => !!id))];
    const [professionals, users, latest]: [any[], any[], any[]] = await Promise.all([
      this.prisma.professional.findMany({
        where: { tenantId, id: { in: profIds } },
        select: { id: true, firstName: true, lastName: true },
      }),
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } })
        : Promise.resolve([]),
      // The latest payout not undone of each professional listed: the one "Deshacer" applies to.
      Promise.all(
        profIds.map((professionalId) =>
          model.findFirst({
            where: { tenantId, professionalId, undoneAt: null },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true },
          }),
        ),
      ),
    ]);
    const nameOf = (list: any[]) => new Map(list.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const profName = nameOf(professionals);
    const userName = nameOf(users);
    const undoable = new Set(latest.filter(Boolean).map((l: any) => l.id));
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      professionalId: r.professionalId,
      professionalName: profName.get(r.professionalId) ?? "",
      amountCents: Number(r.amountCents),
      itemCount: Number(r.itemCount),
      upTo: dayOf(r.upTo),
      createdByName: r.createdById ? (userName.get(r.createdById) ?? null) : null,
      undoneAt: r.undoneAt ?? null,
      undoneByName: r.undoneById ? (userName.get(r.undoneById) ?? null) : null,
      canUndo: undoable.has(r.id),
    }));
  }

  /**
   * Every professional's pending commission (the Comisiones summary tab),
   * each as getCommissionSummary works it out: the active ones, and the
   * deactivated ones that still have something pending ("De baja"), so what
   * is owed to someone who left can still be paid.
   */
  async getAllCommissionSummaries(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<CommissionSummary[]> {
    const professionals: any[] = await this.prisma.professional.findMany({
      where: { tenantId },
    });
    const timeZone = await this.salonTimeZone(tenantId);
    const cutoff = this.upTo(timeZone, now);
    const month = this.monthToDate(timeZone, now);
    const paid = await this.paidByProfessional(tenantId, month.createdAt);
    const terms = await commissionTermsOf(this.prisma, tenantId);
    const paidOf = (id: string) => ({ amount: paid.get(id) ?? 0, period: { start: month.start, end: month.end } });

    const summaries: CommissionSummary[] = [];
    // Active first, then those who left.
    const ordered = [
      ...professionals.filter((p) => p.isActive !== false),
      ...professionals.filter((p) => p.isActive === false),
    ];
    for (const professional of ordered) {
      const active = professional.isActive !== false;
      try {
        const pending = await this.pendingItems(tenantId, professional, cutoff, this.prisma, terms);
        if (!active && pending.entries.length === 0) continue;
        summaries.push(this.toSummary(professional, pending, cutoff.day, paidOf(professional.id)));
      } catch (error) {
        // One professional's data failing does not hide the others.
        this.logger.error(`Commission summary failed for professional ${professional.id}: ${(error as Error).message}`);
        if (!active) continue;
        summaries.push({
          professionalId: professional.id,
          professionalName: `${professional.firstName} ${professional.lastName}`,
          isActive: true,
          totalEarnings: 0,
          pendingCommission: 0,
          paidCommission: paidOf(professional.id).amount,
          paidPeriod: paidOf(professional.id).period,
          pendingUpTo: cutoff.day,
          appointments: [],
        });
      }
    }
    return summaries;
  }

  /** The two days of a report or statement, checked; both included. */
  private periodOf(startDate: Date | string, endDate: Date | string): { start: string; end: string } {
    const start = periodDay(startDate);
    const end = periodDay(endDate);
    if (!start || !end) throw new BadRequestException("Indica las fechas de inicio y fin del periodo (AAAA-MM-DD).");
    return start <= end ? { start, end } : { start: end, end: start };
  }

  /**
   * The payroll report for a date range: per professional, what the
   * period's work sold and earned, and what the period's payouts paid.
   *
   * The same criterion as the summary and "Pagar": completed visits that are
   * paid (`paymentStatus` paid), with their commission snapshot
   * (appointment-commission.ts), and the services and products sold at the
   * till. A visit whose commission was already paid out stays in its period
   * even if it was refunded since (its clawback counts in its own period).
   * Deactivated professionals with work or adjustments in the period are
   * listed too, `isActive: false`. Walk-in services sold without a
   * professional are totalled apart (`unassignedServices`): they earn
   * nobody a commission.
   */
  async getPayrollReport(
    tenantId: string,
    startDate: Date | string,
    endDate: Date | string,
  ): Promise<PayrollReport> {
    // Both days included, whole salon days (commission-period.ts).
    const period = this.periodOf(startDate, endDate);
    const range = commissionPeriodFilters(period.start, period.end, await this.salonTimeZone(tenantId));
    const scheduledDate = range.scheduledDate!;
    const createdAt = range.createdAt!;
    const terms = await commissionTermsOf(this.prisma, tenantId);

    // Every professional: the active ones are always listed, the others
    // only with something in the period.
    const allProfessionals: any[] = await this.prisma.professional.findMany({
      where: { tenantId },
    });
    const professionalById = new Map(allProfessionals.map((p) => [p.id, p]));

    const appointments: any[] = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        scheduledDate,
        status: "completed",
        OR: [{ paymentStatus: "paid" }, { commissionPaid: true }],
      },
      include: {
        professional: true,
      },
    });

    type Row = PayrollReport["professionals"][number];
    const professionalMap = new Map<string, Row>();
    const rowOf = (professionalId: string | null | undefined): Row | undefined => {
      if (!professionalId) return undefined;
      const existing = professionalMap.get(professionalId);
      if (existing) return existing;
      const prof = professionalById.get(professionalId);
      if (!prof) return undefined;
      const row: Row = {
        id: prof.id,
        name: `${prof.firstName} ${prof.lastName}`,
        isActive: prof.isActive !== false,
        totalHours: 0, // Placeholder - would require time tracking
        totalSales: 0,
        productSales: 0,
        commission: 0,
        refundAdjustments: 0,
        adjustments: [],
        paid: 0,
      };
      professionalMap.set(professionalId, row);
      return row;
    };

    // Every active professional, with zero values to start with.
    for (const prof of allProfessionals) {
      if (prof.isActive !== false) rowOf(prof.id);
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
      const existing = rowOf(apt.professionalId);
      if (!existing) continue;
      const share = kept.get(apt.id) ?? 1;
      const { amount } = appointmentCommission(apt, apt.professional?.commissionRate, terms);
      existing.totalSales += Math.round(Number(apt.totalAmount) * share);
      existing.commission += roundCommission(amount * share);
      if (apt.commissionPaid) existing.commission += clawedBack.get(appointmentSourceKey(apt.id)) ?? 0;
    }

    // Services and products sold at the till in the period.
    const unassignedServices = { count: 0, totalSales: 0 };
    for (const line of periodLines) {
      const after = saleLineAfterRefunds({
        commissionBaseCents: line.commissionBaseCents,
        commissionAmount: numberOrNull(line.commissionAmount) ?? 0,
        totalCents: Number(line.totalCents ?? 0),
        refundedCents: line.refundedCents ?? 0,
      });
      if (!line.professionalId) {
        if (after.kept > 0 && line.kind !== "product") {
          unassignedServices.count += 1;
          unassignedServices.totalSales += after.baseCents;
        }
        continue;
      }
      const existing = rowOf(line.professionalId);
      if (existing) {
        existing.totalSales += after.baseCents;
        if (line.kind === "product") existing.productSales += after.baseCents;
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
        const existing = rowOf(r.professionalId);
        if (!existing) continue;
        const amount = roundCommission(numberOrNull(r.amount) ?? 0);
        existing.refundAdjustments = roundCommission(existing.refundAdjustments + amount);
        existing.commission += amount;
        existing.adjustments.push({ id: r.id, date: r.createdAt, refundId: r.refundId, amount, label: REFUND_ADJUSTMENT_LABEL });
      }
    }

    // What the period's payouts paid.
    for (const [professionalId, amount] of await this.paidByProfessional(tenantId, createdAt)) {
      const existing = rowOf(professionalId);
      if (existing) existing.paid += amount;
    }

    // Active first, then those who left.
    const rows = Array.from(professionalMap.values());
    const professionals = [...rows.filter((p) => p.isActive), ...rows.filter((p) => !p.isActive)].map((p) => ({
      ...p,
      commission: roundCommission(p.commission),
    }));

    return {
      period,
      totalPayroll: professionals.reduce((sum, p) => sum + p.commission, 0),
      professionals,
      unassignedServices,
    };
  }

  /**
   * The payroll report as a CSV (";" separated, decimal comma, UTF-8 with
   * BOM so Excel reads the accents). Every text cell goes through
   * csvTextCell: a professional called "=SUM(1)" stays text.
   */
  async getPayrollCsv(
    tenantId: string,
    startDate: Date | string,
    endDate: Date | string,
  ): Promise<{ filename: string; csv: string }> {
    const report = await this.getPayrollReport(tenantId, startDate, endDate);
    const header = [
      "Profesional",
      "Estado",
      "Ventas",
      "De ellas, productos",
      "Ajustes por devolución",
      "Comisión",
      "Pagado en el periodo",
      "% sobre ventas",
    ];
    const share = (commission: number, sales: number) =>
      csvNumberCell(sales > 0 ? ((commission / sales) * 100).toFixed(1).replace(".", ",") : "0,0");
    const lines = [header.map((h) => csvTextCell(h)).join(";")];
    for (const p of report.professionals) {
      lines.push(
        [
          csvTextCell(p.name),
          csvTextCell(p.isActive ? "Activa" : "De baja"),
          csvEuros(p.totalSales),
          csvEuros(p.productSales),
          csvEuros(p.refundAdjustments),
          csvEuros(p.commission),
          csvEuros(p.paid),
          share(p.commission, p.totalSales),
        ].join(";"),
      );
    }
    if (report.unassignedServices.count > 0) {
      lines.push(
        [
          csvTextCell("Servicios sin profesional"),
          csvTextCell(`${report.unassignedServices.count} sin asignar`),
          csvEuros(report.unassignedServices.totalSales),
          "",
          "",
          "",
          "",
          "",
        ].join(";"),
      );
    }
    lines.push([csvTextCell("Total"), "", "", "", "", csvEuros(report.totalPayroll), "", ""].join(";"));
    return {
      filename: `comisiones_${report.period.start}_${report.period.end}.csv`,
      // The BOM, so Excel reads the file as UTF-8 (the accents).
      csv: String.fromCharCode(0xfeff) + lines.join(CRLF) + CRLF,
    };
  }

  /**
   * "Ver extracto": one professional's period, line by line -- the visits
   * and till sales of the period with their commission and whether it was
   * paid out, the refund adjustments recorded in it, and the payouts made
   * in it -- with the totals.
   */
  async getStatement(
    tenantId: string,
    professionalId: string,
    startDate: Date | string,
    endDate: Date | string,
  ): Promise<{
    professional: { id: string; name: string; isActive: boolean; serviceRate: number; productRate: number };
    period: { start: string; end: string };
    lines: CommissionEntry[];
    adjustments: CommissionEntry[];
    payouts: PayoutView[];
    totals: { sales: number; earned: number; adjustments: number; net: number; paid: number };
  }> {
    const professional: any = await this.prisma.professional.findFirst({ where: { id: professionalId, tenantId } });
    if (!professional) throw new NotFoundException("Profesional no encontrado");
    const period = this.periodOf(startDate, endDate);
    const range = commissionPeriodFilters(period.start, period.end, await this.salonTimeZone(tenantId));
    const terms = await commissionTermsOf(this.prisma, tenantId);
    const rates = professionalRates(professional, terms);

    const appointments: any[] = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        professionalId,
        scheduledDate: range.scheduledDate,
        status: "completed",
        OR: [{ paymentStatus: "paid" }, { commissionPaid: true }],
      },
      include: { client: true, service: true },
      orderBy: { scheduledDate: "asc" },
    });
    const kept = await appointmentKeptShares(this.prisma, tenantId, appointments.map((a) => a.id));
    const visits: CommissionEntry[] = appointments.map((apt) => {
      // A visit paid out keeps what it was paid with, even if refunded since
      // (the refund's adjustment counts in its own period), as the report.
      const { rate, amount } = appointmentCommission(apt, professional.commissionRate, terms);
      const share = kept.get(apt.id) ?? 1;
      return {
        id: apt.id,
        date: apt.scheduledDate,
        clientName: apt.client ? `${apt.client.firstName} ${apt.client.lastName}` : "Clienta",
        serviceName: apt.service?.name ?? apt.serviceName ?? "Servicio",
        amount: Math.round(Number(apt.totalAmount) * share),
        commissionRate: rate,
        commissionAmount: roundCommission(amount * share),
        paid: !!apt.commissionPaid,
        source: "appointment" as const,
      };
    });
    const periodLines = await this.saleLines({ tenantId, professionalId, createdAt: range.createdAt });
    const clawedBack = await clawedBackBySource(this.prisma, tenantId, {
      appointmentIds: appointments.filter((a) => a.commissionPaid).map((a) => a.id),
      lineIds: periodLines.filter((l) => l.commissionPaid).map((l) => l.id),
    });
    // As the payroll report: what a later refund took back of a paid item
    // is added back here (it counts in the period of its adjustment).
    for (const v of visits) {
      if (v.paid) v.commissionAmount += clawedBack.get(appointmentSourceKey(v.id)) ?? 0;
    }
    const sales = this.saleEntries(periodLines, rates).reverse();
    for (const s of sales) {
      if (s.paid) s.commissionAmount += clawedBack.get(saleLineSourceKey(s.id)) ?? 0;
    }
    const adjustments = (
      await this.adjustmentEntries(tenantId, professionalId, { createdAt: range.createdAt, settled: undefined })
    ).reverse();
    const payouts = (await this.listPayouts(tenantId, { professionalId, limit: 500 })).filter((p) => {
      const at = new Date(p.createdAt).getTime();
      return (
        !p.undoneAt &&
        (!range.createdAt?.gte || at >= range.createdAt.gte.getTime()) &&
        (!range.createdAt?.lt || at < range.createdAt.lt.getTime())
      );
    });

    const lines = [...visits, ...sales].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const sum = (list: Array<{ commissionAmount: number }>) => list.reduce((s, e) => s + e.commissionAmount, 0);
    const earned = sum(lines);
    const adjustmentsTotal = sum(adjustments);
    return {
      professional: {
        id: professional.id,
        name: `${professional.firstName} ${professional.lastName}`,
        isActive: professional.isActive !== false,
        serviceRate: rates.service,
        productRate: rates.product,
      },
      period,
      lines,
      adjustments,
      payouts,
      totals: {
        sales: lines.reduce((s, e) => s + e.amount, 0),
        earned,
        adjustments: adjustmentsTotal,
        net: earned + adjustmentsTotal,
        paid: payouts.reduce((s, p) => s + p.amountCents, 0),
      },
    };
  }

  /** "Comisión por defecto", "Comisión de productos" by default and "Comisión sobre". */
  async getSettings(tenantId: string): Promise<CommissionSettings> {
    const terms = await commissionTermsOf(this.prisma, tenantId);
    return {
      defaultRate: terms.defaultRate,
      productDefaultRate: terms.productDefaultRate,
      base: terms.base,
      pricesIncludeTax: terms.pricesIncludeTax,
    };
  }

  /**
   * Changes the salon's commission terms (owner or admin), audit-logged with
   * the values before and after. They apply to what is not paid out yet:
   * visits work their commission out when read, till lines keep what they
   * were sold with; payouts already made are never rewritten.
   */
  async updateSettings(
    tenantId: string,
    dto: UpdateCommissionSettingsDto,
    actor?: CommissionActor,
  ): Promise<CommissionSettings> {
    const before = await this.getSettings(tenantId);
    const data: Record<string, unknown> = {};
    if (dto.defaultRate !== undefined) data.commissionDefaultRate = dto.defaultRate;
    if (dto.productDefaultRate !== undefined) data.productCommissionDefaultRate = dto.productDefaultRate;
    if (dto.base !== undefined) data.commissionBase = dto.base;
    if (Object.keys(data).length === 0) return before;
    await this.prisma.$transaction(async (tx: Db) => {
      await tx.tenant.update({ where: { id: tenantId }, data });
      await this.audit(tx, "commission.settings.updated", tenantId, actor, {
        before: { defaultRate: before.defaultRate, productDefaultRate: before.productDefaultRate, base: before.base },
        changes: { ...dto },
      });
    });
    return this.getSettings(tenantId);
  }

  private async audit(
    tx: Db,
    action: string,
    tenantId: string,
    actor: CommissionActor | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditLog || !actor?.id) return;
    await this.auditLog.record(action, { actorId: actor.id, actorRole: actor.role as UserRole, tenantId, metadata }, tx);
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
