import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { TaxReportType, TaxReportStatus } from "@prisma/client";
import {
  taxRegimeOf,
  TAX_REGIME_QUARTERLY_REPORT,
  TAX_REGIME_LABELS,
  TAX_REGIME_TERRITORIES,
} from "@kira/shared";
import { aggregateModelo303, invoiceBases } from "./modelo-303";
import { aggregateModelo420 } from "./modelo-420";
import { effectiveTaxBreakdown } from "../invoice-calculator.service";
import { dayOfIssueDate } from "../invoice-numbering";
import { validateNif } from "../../common/validation/nif.validator";

/** The invoices a tax report counts: issued ones, not cancelled ones. */
const REPORTED_STATUSES = ["issued", "paid", "refunded"] as const;

/** Under the income card of the modelo 130. */
export const MODELO_130_INCOME_NOTE = "Los gastos y el cálculo final del modelo 130 los hace tu gestor.";

/** A quarter's line of the income card. Amounts in cents, tax not included. */
export interface Modelo130IncomeQuarter {
  quarter: number;
  /** Base imponible of the quarter's invoices. */
  invoicedCents: number;
  /** Base imponible of its rectificativas (negative or 0). */
  rectifiedCents: number;
  /** invoicedCents + rectifiedCents. */
  incomeCents: number;
  /** From 1 January to the end of this quarter, as the 130 asks. */
  cumulativeCents: number;
}

/**
 * Spanish quarterly tax declarations (Modelo 303, Modelo 420), and the
 * income an autónomo needs for the Modelo 130.
 *
 * MVP scope: generate the **draft** declaration JSON so the SaaS
 * admin can review it in the dashboard. Auto-submission to AEAT is
 * NOT enabled in v1 — that's a separate feature gated on legal review.
 *
 * Modelo 303 (IVA) and Modelo 420 (IGIC) aggregate `Invoice` rows where
 *   status ∈ {issued, paid, refunded}
 *   and `issueDate` ∈ [quarter start, quarter end]
 * by `taxBreakdown[].rate`, into the box layout of each tax agency's own
 * instructions: see modelo-303.ts (AEAT) and modelo-420.ts (ATC).
 *
 * There is no Modelo 130 draft. It used to sum invoice totals with the VAT
 * in them and fill made-up boxes; now income130() gives the income from
 * invoices (base imponible, per quarter and cumulative) and the salon's
 * gestor does the expenses and the return.
 */
@Injectable()
export class TaxReportsService {
  private readonly logger = new Logger(TaxReportsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Quarter date ranges — calendar-year boundaries, EU/Spain
   * timezone. (For tax purposes the actual deadline is the 20th of
   * the following month; the report period itself is fixed.)
   */
  static quarterRange(year: number, quarter: number): {
    start: Date;
    end: Date;
  } {
    const startMonth = (quarter - 1) * 3; // 0, 3, 6, 9
    const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59)); // last day of quarter
    return { start, end };
  }

  /**
   * Generate a draft declaration. Persists it as `draft` and returns
   * the row. Idempotent — re-running for the same (tenantId, type,
   * year, quarter) overwrites the existing row.
   */
  async generate(
    tenantId: string,
    type: TaxReportType,
    year: number,
    quarter: number,
  ): Promise<{
    id: string;
    type: TaxReportType;
    year: number;
    quarter: number;
    totalsJson: any;
    status: TaxReportStatus;
  }> {
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
      throw new BadRequestException(`El trimestre ${quarter} no existe: tiene que ser 1, 2, 3 o 4.`);
    }
    if (type !== TaxReportType.modelo_303 && type !== TaxReportType.modelo_420) {
      throw new BadRequestException(unknownReportType(type));
    }

    await this.assertReportMatchesRegime(tenantId, type);

    const { start, end } = TaxReportsService.quarterRange(year, quarter);

    const rows = await this.prisma.invoice.findMany({
      where: {
        tenantId,
        status: { in: [...REPORTED_STATUSES] },
        issueDate: { gte: start, lte: end },
      },
      select: {
        id: true,
        series: true,
        totalCents: true,
        taxBreakdown: true,
        lines: { select: { taxRate: true, taxCents: true, totalCents: true } },
      },
    });
    // The breakdown by rate is worked out again from the invoice's lines
    // (effectiveTaxBreakdown: old ones stored IGIC 9,5 % as 10 %), as the
    // libro de facturas does, so the two reconcile.
    const invoices = rows.map(({ lines, ...inv }) => ({
      ...inv,
      taxBreakdown: effectiveTaxBreakdown({ taxBreakdown: inv.taxBreakdown, lines }),
    }));

    // Exhaustive on purpose: an unknown type is refused, never given another
    // return's layout.
    let totals: Record<string, number>;
    switch (type) {
      case TaxReportType.modelo_303:
        // Box layout from the AEAT's 2026 instructions and diseño de
        // registro (see modelo-303.ts).
        totals = aggregateModelo303(invoices);
        break;
      case TaxReportType.modelo_420:
        // Box layout from the Agencia Tributaria Canaria's own instructions
        // (see modelo-420.ts); it used to be refused rather than guessed.
        totals = aggregateModelo420(invoices);
        break;
      default:
        throw new BadRequestException(unknownReportType(type));
    }

    const row = await this.prisma.taxReport.upsert({
      where: {
        tenantId_type_year_quarter: { tenantId, type, year, quarter },
      },
      create: {
        tenantId,
        type,
        year,
        quarter,
        totalsJson: totals as any,
        fiscalStatus: "draft",
      },
      update: {
        totalsJson: totals as any,
        // Drafts are recomputed; submitted/accepted reports are not.
        generatedAt: new Date(),
        fiscalStatus: "draft",
        fiscalError: null,
      },
    });
    return {
      id: row.id,
      type: row.type,
      year: row.year,
      quarter: row.quarter,
      totalsJson: row.totalsJson,
      status: row.fiscalStatus,
    };
  }

  /**
   * Refuses a quarterly return that does not belong to the tenant's tax
   * regime.
   *
   * Without this, a Canarian salon asking for a Modelo 303 got a report full
   * of zeros and no error: the old 303 aggregator read only the buckets for
   * 21, 10 and 4 — the IVA rates — so IGIC at 7 % matched none of them, every
   * box came out 0 and the report was saved as a valid draft. (The current
   * aggregator refuses rates it has no row for, but the regime is the reason
   * to refuse, so it is checked first.) A tax return that is silently wrong is
   * worse than a missing feature: someone might file it.
   */
  private async assertReportMatchesRegime(
    tenantId: string,
    type: TaxReportType,
  ): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { fiscalSettings: true },
    });
    const regime = taxRegimeOf(tenant?.fiscalSettings);
    const expected = TAX_REGIME_QUARTERLY_REPORT[regime];

    if (expected === null) {
      throw new BadRequestException(
        `Con ${TAX_REGIME_LABELS[regime]} (${TAX_REGIME_TERRITORIES[regime]}) la declaración trimestral se ` +
          `presenta en tu ciudad autónoma, con un modelo que KiraRoom no prepara. Exporta el libro de facturas ` +
          `y pásaselo a tu gestor.`,
      );
    }

    if (type !== expected) {
      throw new BadRequestException(
        `Tu salón tributa con ${TAX_REGIME_LABELS[regime]} (${TAX_REGIME_TERRITORIES[regime]}), ` +
          `y su declaración trimestral es el ${reportName(expected)}, no el ${reportName(type)}: ` +
          `ese saldría a cero, porque solo suma los tipos de otro impuesto.`,
      );
    }
  }

  /**
   * The income of an autónomo (NIF or NIE; a company, with a CIF, files no
   * 130) for the Modelo 130 of `year`: per quarter and cumulative, the base
   * imponible (tax not included) of the invoices issued, rectificativas
   * subtracted, as the 303 counts them (invoiceBases). By the salon's
   * calendar day of each invoice. `applies: false` for a salon with a CIF or
   * no NIF yet: the panel shows no card then.
   */
  async income130(tenantId: string, year: number) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException(`El año ${year} no es válido.`);
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { taxId: true, taxIdType: true, timezone: true, fiscalSettings: true },
    });
    const settings = (tenant?.fiscalSettings as Record<string, unknown> | null) ?? {};
    const taxId = tenant?.taxId || (typeof settings.tenantNif === "string" ? settings.tenantNif : null);
    const type = tenant?.taxIdType ?? (taxId ? validateNif(taxId).type : undefined) ?? null;
    if (type !== "nif" && type !== "nie") {
      return { applies: false as const, year, taxIdType: type, quarters: [], note: MODELO_130_INCOME_NOTE };
    }

    // A day either side: older issue dates are instants, read as the salon's day.
    const rows = await this.prisma.invoice.findMany({
      where: {
        tenantId,
        status: { in: [...REPORTED_STATUSES] },
        issueDate: { gte: new Date(Date.UTC(year - 1, 11, 31)), lt: new Date(Date.UTC(year + 1, 0, 2)) },
      },
      select: {
        series: true,
        totalCents: true,
        taxBreakdown: true,
        issueDate: true,
        lines: { select: { taxRate: true, taxCents: true, totalCents: true } },
      },
    });
    const byQuarter: Array<Parameters<typeof invoiceBases>[0]> = [[], [], [], []];
    for (const { lines, issueDate, ...inv } of rows) {
      const day = dayOfIssueDate(new Date(issueDate), tenant?.timezone);
      if (Number(day.slice(0, 4)) !== year) continue;
      const quarter = Math.floor((Number(day.slice(5, 7)) - 1) / 3);
      byQuarter[quarter].push({ ...inv, taxBreakdown: effectiveTaxBreakdown({ taxBreakdown: inv.taxBreakdown, lines }) });
    }
    let cumulativeCents = 0;
    const quarters: Modelo130IncomeQuarter[] = byQuarter.map((invoices, i) => {
      const { invoicedCents, rectifiedCents } = invoiceBases(invoices);
      const incomeCents = invoicedCents + rectifiedCents;
      cumulativeCents += incomeCents;
      return { quarter: i + 1, invoicedCents, rectifiedCents, incomeCents, cumulativeCents };
    });
    return { applies: true as const, year, taxIdType: type, quarters, note: MODELO_130_INCOME_NOTE };
  }

  /**
   * Which quarterly return the tenant files, from its tax regime: modelo_303
   * (IVA), modelo_420 (IGIC) or null (IPSI: filed with the city council).
   */
  async quarterlyReturnFor(tenantId: string): Promise<{ regime: string; type: string | null }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { fiscalSettings: true },
    });
    const regime = taxRegimeOf(tenant?.fiscalSettings);
    return { regime, type: TAX_REGIME_QUARTERLY_REPORT[regime] };
  }

  /**
   * Fetch an existing draft. Returns null if no report has been
   * generated yet for the period.
   */
  async find(
    tenantId: string,
    type: TaxReportType,
    year: number,
    quarter: number,
  ) {
    return this.prisma.taxReport.findUnique({
      where: {
        tenantId_type_year_quarter: { tenantId, type, year, quarter },
      },
    });
  }

  /**
   * List all reports for a tenant, newest first.
   */
  async listForTenant(tenantId: string, limit = 50) {
    return this.prisma.taxReport.findMany({
      // Old Modelo 130 drafts (no longer generated) are left out.
      where: { tenantId, type: { in: [TaxReportType.modelo_303, TaxReportType.modelo_420] } },
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
      take: limit,
    });
  }
}

/** "modelo 303 (IVA)". */
function reportName(type: string): string {
  if (type === TaxReportType.modelo_303) return "modelo 303 (IVA)";
  if (type === TaxReportType.modelo_420) return "modelo 420 (IGIC)";
  return type;
}

/** Why a report type is refused, in Spanish. */
export function unknownReportType(type: string): string {
  return type === TaxReportType.modelo_130
    ? "KiraRoom ya no prepara el modelo 130: en Contabilidad tienes los ingresos de cada trimestre para tu gestor."
    : `No existe la declaración "${type}": KiraRoom prepara el modelo 303 (IVA) y el 420 (IGIC).`;
}
