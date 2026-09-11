import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { UserRole, TaxReportType } from "@prisma/client";
import { TaxReportsService } from "./tax-reports.service";

interface AuthedRequest extends Request {
  user: { tenantId?: string };
}

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

  @Get(":type/:year/:quarter")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
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
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async list(@Req() req: AuthedRequest, @Query("limit") limit?: string) {
    const cap = limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50;
    return this.reports.listForTenant(this.tenantId(req), cap);
  }

  private parseType(type: string): TaxReportType {
    if (type === TaxReportType.modelo_303) return TaxReportType.modelo_303;
    if (type === TaxReportType.modelo_130) return TaxReportType.modelo_130;
    throw new BadRequestException(`Unknown tax report type: ${type}`);
  }

  private tenantId(req: AuthedRequest): string {
    const t = req.user?.tenantId;
    if (!t) throw new BadRequestException("Missing tenantId");
    return t;
  }
}
