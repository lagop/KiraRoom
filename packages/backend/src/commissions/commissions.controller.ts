import { Controller, Get, Post, Patch, Body, Param, ParseUUIDPipe, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UserRole } from "@prisma/client";
import { CommissionsService } from "./commissions.service";
import {
  CommissionPayoutsQueryDto,
  CommissionPeriodQueryDto,
  CommissionSummaryQueryDto,
  PayCommissionDto,
  UpdateCommissionSettingsDto,
} from "./dto/commission.dto";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";

/** The signed-in user as the audit log records them. */
const actorOf = (user: any) => ({ id: user?.id, role: user?.role });

@ApiTags("commissions")
@Controller("commissions")
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Feature("commissions")
@ApiBearerAuth()
export class CommissionsController {
  constructor(private readonly commissionsService: CommissionsService) {}

  /**
   * "Mis comisiones" (staff): their own pending and paid commission, in the
   * summary's shape, with their payouts. Read-only.
   */
  @Get("me")
  @Roles(UserRole.staff)
  @ApiOperation({ summary: "Get current user's own commission summary" })
  async getMyCommissions(@CurrentUser() user: any) {
    return this.commissionsService.getMyCommissions(user.tenantId, user.id);
  }

  /** The salon's commission terms ("Comisión por defecto", products, "Comisión sobre"). */
  @Get("settings")
  @Roles(...SALON_MANAGERS)
  async getSettings(@CurrentUser() user: any) {
    return this.commissionsService.getSettings(user.tenantId);
  }

  @Patch("settings")
  @Roles(...SALON_MANAGERS)
  async updateSettings(@CurrentUser() user: any, @Body() dto: UpdateCommissionSettingsDto) {
    return this.commissionsService.updateSettings(user.tenantId, dto, actorOf(user));
  }

  /**
   * A professional's pending commission, up to today or to `upTo` ("Pagar
   * hasta", a salon day): what the "Pagar" dialog shows.
   */
  @Get("summary/:professionalId")
  @Roles(...SALON_MANAGERS)
  async getCommissionSummary(
    @CurrentUser() user: any,
    @Param("professionalId") professionalId: string,
    @Query() query: CommissionSummaryQueryDto,
  ) {
    return this.commissionsService.getCommissionSummary(user.tenantId, professionalId, new Date(), query.upTo);
  }

  /**
   * Get all commission summaries for the tenant (Admin/Owner only)
   */
  @Get("all")
  @Roles(UserRole.owner, UserRole.admin)
  async getAllCommissionSummaries(@CurrentUser() user: any) {
    return this.commissionsService.getAllCommissionSummaries(user.tenantId);
  }

  /**
   * "Pagar": pays what is pending for a professional (up to `endDate`, or
   * today) and records the payout.
   */
  @Post("pay/:professionalId")
  @Roles(...SALON_MANAGERS)
  async payCommission(
    @CurrentUser() user: any,
    @Param("professionalId") professionalId: string,
    @Body() dto: PayCommissionDto,
  ) {
    return this.commissionsService.payCommission(user.tenantId, professionalId, dto, new Date(), actorOf(user));
  }

  /** "Pagos": the payout history, newest first. */
  @Get("payouts")
  @Roles(...SALON_MANAGERS)
  async listPayouts(@CurrentUser() user: any, @Query() query: CommissionPayoutsQueryDto) {
    return this.commissionsService.listPayouts(user.tenantId, query);
  }

  /** "Deshacer último pago": only a professional's latest payout; audit-logged. */
  @Post("payouts/:payoutId/undo")
  @Roles(...SALON_MANAGERS)
  async undoPayout(@CurrentUser() user: any, @Param("payoutId", ParseUUIDPipe) payoutId: string) {
    return this.commissionsService.undoPayout(user.tenantId, payoutId, actorOf(user));
  }

  /**
   * Get payroll report for a date range (Admin/Owner only)
   */
  @Get("payroll")
  @Roles(UserRole.owner, UserRole.admin)
  async getPayrollReport(@CurrentUser() user: any, @Query() query: CommissionPeriodQueryDto) {
    // "YYYY-MM-DD" days, both included (commission-period.ts).
    return this.commissionsService.getPayrollReport(user.tenantId, query.startDate, query.endDate);
  }

  /** The payroll report as a CSV (csv-cell.ts escaping). */
  @Get("payroll.csv")
  @Roles(UserRole.owner, UserRole.admin)
  async getPayrollCsv(
    @CurrentUser() user: any,
    @Query() query: CommissionPeriodQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { filename, csv } = await this.commissionsService.getPayrollCsv(user.tenantId, query.startDate, query.endDate);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return csv;
  }

  /** "Ver extracto": a professional's period, line by line, with adjustments and payouts. */
  @Get("statement/:professionalId")
  @Roles(UserRole.owner, UserRole.admin)
  async getStatement(
    @CurrentUser() user: any,
    @Param("professionalId", ParseUUIDPipe) professionalId: string,
    @Query() query: CommissionPeriodQueryDto,
  ) {
    return this.commissionsService.getStatement(user.tenantId, professionalId, query.startDate, query.endDate);
  }
}
