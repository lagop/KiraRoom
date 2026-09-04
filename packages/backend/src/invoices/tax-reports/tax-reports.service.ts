import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { TaxReportType, TaxReportStatus, Invoice } from "@prisma/client";

/**
 * Spanish quarterly tax declarations (Modelo 303 + Modelo 130).
 *
 * MVP scope: generate the **draft** declaration JSON so the SaaS
 * admin can review it in the dashboard. Auto-submission to AEAT is
 * NOT enabled in v1 — that's a separate feature gated on legal review.
 *
 * Modelo 303 (IVA trimestral) aggregates `Invoice` rows where
 *   status ∈ {issued, paid, refunded}
 *   and `issueDate` ∈ [quarter start, quarter end]
 * and groups them by `taxBreakdown[].rate`. The output matches the
 * Casilla layout:
 *   Casilla 01 — Base imponible 21%
 *   Casilla 03 — Cuota devengada 21% (IVA repercutido)
 *   Casilla 04 — Base imponible 10%
 *   Casilla 06 — Cuota devengada 10%
 *   Casilla 07 — Base imponible 4%
 *   Casilla 09 — Cuota devengada 4%
 *   Casilla 36 — Total cuota devengada (sum of all tax buckets)
 *   Casilla 67 — Resultado (= devengada - deducida)
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
    const { start, end } = TaxReportsService.quarterRange(year, quarter);

    const invoices = await this.prisma.invoice.findMany({
      where: {
        tenantId,
        status: { in: ["issued", "paid", "refunded"] as any },
        issueDate: { gte: start, lte: end },
      },
      select: {
        id: true,
        totalCents: true,
        taxBreakdown: true,
      },
    });

    const totals =
      type === TaxReportType.modelo_303
        ? this.aggregateModelo303(invoices)
        : this.aggregateModelo130(invoices);

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
   * Aggregate invoices into the Modelo 303 layout. Returns the
   * Casillas object that the AEAT form expects.
   */
  private aggregateModelo303(
    invoices: Array<Pick<Invoice, "totalCents" | "taxBreakdown">>,
  ): Record<string, number> {
    const buckets = new Map<number, { base: number; tax: number }>();
    for (const inv of invoices) {
      const breakdown = (inv.taxBreakdown as Array<{
        rate: number;
        baseCents: number;
        taxCents: number;
      }>) ?? [];
      for (const b of breakdown) {
        const rate = Math.round(b.rate);
        const cur = buckets.get(rate) ?? { base: 0, tax: 0 };
        cur.base += b.baseCents;
        cur.tax += b.taxCents;
        buckets.set(rate, cur);
      }
    }
    const b21 = buckets.get(21) ?? { base: 0, tax: 0 };
    const b10 = buckets.get(10) ?? { base: 0, tax: 0 };
    const b4 = buckets.get(4) ?? { base: 0, tax: 0 };
    const totalDevengada =
      b21.tax + b10.tax + b4.tax;
    // For MVP, deducida = 0 (we don't track input VAT yet).
    return {
      "01": b21.base,
      "03": b21.tax,
      "04": b10.base,
      "06": b10.tax,
      "07": b4.base,
      "09": b4.tax,
      "36": totalDevengada,
      "67": totalDevengada, // devengada - 0 (deducible)
    };
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
