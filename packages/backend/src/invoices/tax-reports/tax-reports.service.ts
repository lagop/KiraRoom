import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { TaxReportType, TaxReportStatus, Invoice } from "@prisma/client";
import {
  taxRegimeOf,
  TAX_REGIME_QUARTERLY_REPORT,
  TAX_REGIME_LABELS,
  TAX_REGIME_TERRITORIES,
} from "@kira/shared";
import { aggregateModelo303 } from "./modelo-303";
import { aggregateModelo420 } from "./modelo-420";

/**
 * Spanish quarterly tax declarations (Modelo 303, Modelo 420 + Modelo 130).
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
 * Modelo 130 (IRPF estimación directa) is a single declaration per
 * quarter. We compute it from invoice totals (this is a *rough* first
 * pass — full Modelo 130 has gastos deducibles, retenciones, etc.
 * that we don't track yet). The MVP value is to give the SaaS admin
 * a starting point.
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
    if (quarter < 1 || quarter > 4) {
      throw new Error(`Invalid quarter ${quarter} (must be 1..4)`);
    }

    await this.assertReportMatchesRegime(tenantId, type);

    const { start, end } = TaxReportsService.quarterRange(year, quarter);

    const invoices = await this.prisma.invoice.findMany({
      where: {
        tenantId,
        status: { in: ["issued", "paid", "refunded"] as any },
        issueDate: { gte: start, lte: end },
      },
      select: {
        id: true,
        series: true,
        totalCents: true,
        taxBreakdown: true,
      },
    });

    // Exhaustive on purpose. The old ternary sent anything that was not a 303
    // to the 130 aggregator, so adding modelo_420 to the enum would have
    // silently produced an IRPF layout for an IGIC return.
    let totals: Record<string, number>;
    switch (type) {
      case TaxReportType.modelo_303:
        // Box layout from the AEAT's 2026 instructions and diseño de
        // registro (see modelo-303.ts).
        totals = aggregateModelo303(invoices);
        break;
      case TaxReportType.modelo_130:
        totals = this.aggregateModelo130(invoices);
        break;
      case TaxReportType.modelo_420:
        // Box layout from the Agencia Tributaria Canaria's own instructions
        // (see modelo-420.ts); it used to be refused rather than guessed.
        totals = aggregateModelo420(invoices);
        break;
      default: {
        const exhaustive: never = type;
        throw new BadRequestException(`Unsupported tax report type: ${exhaustive}`);
      }
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
   *
   * Modelo 130 (IRPF) is not an indirect-tax return, so it applies under any
   * regime and is not checked here.
   */
  private async assertReportMatchesRegime(
    tenantId: string,
    type: TaxReportType,
  ): Promise<void> {
    if (type === TaxReportType.modelo_130) return;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { fiscalSettings: true },
    });
    const regime = taxRegimeOf(tenant?.fiscalSettings);
    const expected = TAX_REGIME_QUARTERLY_REPORT[regime];

    if (expected === null) {
      throw new BadRequestException(
        `Tenants under ${TAX_REGIME_LABELS[regime]} (${TAX_REGIME_TERRITORIES[regime]}) ` +
          `file with their own city council, on a form this product does not generate. ` +
          `Export the invoices instead.`,
      );
    }

    if (type !== expected) {
      throw new BadRequestException(
        `This tenant's tax regime is ${TAX_REGIME_LABELS[regime]} ` +
          `(${TAX_REGIME_TERRITORIES[regime]}), whose quarterly return is ` +
          `${expected}, not ${type}. Generating ${type} would report zeros, ` +
          `because it only aggregates the rates of another regime.`,
      );
    }
  }

  /**
   * MVP Modelo 130 (IRPF). For now, this computes a 20% flat rate over
   * the total invoiced (Spanish estimación directa for actividades
   * económicas sin módulos). Real deducible-gastos calculation is a
   * future iteration; for now we surface the gross amount so the SaaS
   * admin can review.
   */
  private aggregateModelo130(
    invoices: Array<Pick<Invoice, "totalCents" | "taxBreakdown">>,
  ): Record<string, number> {
    let totalIngresos = 0;
    for (const inv of invoices) totalIngresos += inv.totalCents;
    // 20% over ingresos, expressed in cents to match the rest of the
    // codebase's money-as-cents convention.
    const rendimiento = Math.round(totalIngresos * 0.2);
    const retenciones = 0;
    return {
      "01": totalIngresos,
      "02": rendimiento,
      "03": retenciones,
      "18": rendimiento - retenciones, // cuota diferencial
    };
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
      where: { tenantId },
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
      take: limit,
    });
  }
}
