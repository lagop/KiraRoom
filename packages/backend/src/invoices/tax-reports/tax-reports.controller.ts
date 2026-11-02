import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { Roles, SALON_MANAGERS } from "../../auth/decorators/roles.decorator";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { UserRole, TaxReportType } from "@prisma/client";
import { TaxReportsService } from "./tax-reports.service";

interface AuthedRequest extends Request {
  user: { tenantId?: string };
}

/**
 * The quarterly drafts hold the salon's takings (bases and cuotas), which
 * invoices and analytics hide from staff: every route is the owner's and
 * admins'. Staff used to be able to read the list and each draft.
 */
@Controller("tax-reports")
@UseGuards(JwtAuthGuard, RolesGuard)
export class TaxReportsController {
  constructor(private readonly reports: TaxReportsService) {}

  /**
   * Generate (or regenerate) the draft declaration for the period.
   * Idempotent — re-running overwrites the same row.
   */
  @Post(":type/:year/:quarter/generate")
  @Roles(UserRole.owner, UserRole.admin)
  @HttpCode(200)
  async generate(
    @Req() req: AuthedRequest,
    @Param("type") type: string,
    @Param("year", ParseIntPipe) year: number,
    @Param("quarter", ParseIntPipe) quarter: number,
  ) {
    const t = this.parseType(type);
    return this.reports.generate(this.tenantId(req), t, year, quarter);
  }

  /** The quarterly return of the salon's tax regime (303, 420 or none). */
  @Get("quarterly-type")
  @Roles(...SALON_MANAGERS)
  quarterlyType(@Req() req: AuthedRequest) {
    return this.reports.quarterlyReturnFor(this.tenantId(req));
  }

  @Get(":type/:year/:quarter")
  @Roles(...SALON_MANAGERS)
  async findOne(
    @Req() req: AuthedRequest,
    @Param("type") type: string,
    @Param("year", ParseIntPipe) year: number,
    @Param("quarter", ParseIntPipe) quarter: number,
  ) {
    const t = this.parseType(type);
    const r = await this.reports.find(this.tenantId(req), t, year, quarter);
    if (!r) {
      throw new BadRequestException(
        "No tax report generated yet for this period",
      );
    }
    return r;
  }

  @Get()
  @Roles(...SALON_MANAGERS)
  async list(@Req() req: AuthedRequest, @Query("limit") limit?: string) {
    const cap = limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50;
    return this.reports.listForTenant(this.tenantId(req), cap);
  }

  private parseType(type: string): TaxReportType {
    if (type === TaxReportType.modelo_303) return TaxReportType.modelo_303;
    if (type === TaxReportType.modelo_420) return TaxReportType.modelo_420;
    if (type === TaxReportType.modelo_130) return TaxReportType.modelo_130;
    throw new BadRequestException(`Unknown tax report type: ${type}`);
  }

  private tenantId(req: AuthedRequest): string {
    const t = req.user?.tenantId;
    if (!t) throw new BadRequestException("Missing tenantId");
    return t;
  }
}
