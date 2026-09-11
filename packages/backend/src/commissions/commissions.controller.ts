import { Controller, Get, Post, Body, Param, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UserRole } from "@prisma/client";
import {
  CommissionsService,
  CalculateCommissionDto,
  PayCommissionDto } from "./commissions.service";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";

@ApiTags("commissions")
@Controller("commissions")
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Feature("commissions")
@ApiBearerAuth()
export class CommissionsController {
  constructor(private readonly commissionsService: CommissionsService) {}

  /**
   * Get current user's own commissions (for Staff role)
   */
  @Get("me")
  @Roles(UserRole.staff)
  @ApiOperation({ summary: "Get current user's own commission summary" })
  async getMyCommissions(@CurrentUser() user: any) {
    // Obtener el professionalId del usuario actual
    const professional = await this.commissionsService.getProfessionalByUserId(
      user.id,
      user.tenantId,
    );
    if (!professional) {
      return { pending: 0, paid: 0, total: 0 };
    }

    return this.commissionsService.getCommissionSummary(
      user.tenantId,
      professional.id,
    );
  }

  /**
   * Calculate commission for a specific appointment
   */
  @Post("calculate/:appointmentId")
  async calculateCommission(
    @CurrentUser() user: any,
    @Param("appointmentId") appointmentId: string,
    @Body() dto: { amount?: number; rate?: number },
  ) {
    return this.commissionsService.calculateCommission(user.tenantId, {
      appointmentId,
      amount: dto?.amount,
      rate: dto?.rate });
  }

  /**
   * Calculate pending commissions for a professional
   */
  @Get("pending/:professionalId")
  async getPendingCommissions(
    @CurrentUser() user: any,
    @Param("professionalId") professionalId: string,
  ) {
    return this.commissionsService.calculatePendingCommissions(
      user.tenantId,
      professionalId,
    );
  }

  /**
   * Get commission summary for a professional
   */
  @Get("summary/:professionalId")
  async getCommissionSummary(
    @CurrentUser() user: any,
    @Param("professionalId") professionalId: string,
  ) {
    return this.commissionsService.getCommissionSummary(
      user.tenantId,
      professionalId,
    );
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
   * Pay commissions for a professional
   */
  @Post("pay/:professionalId")
  async payCommission(
    @CurrentUser() user: any,
    @Param("professionalId") professionalId: string,
    @Body() dto: PayCommissionDto,
  ) {
    return this.commissionsService.payCommission(
      user.tenantId,
      professionalId,
      dto,
    );
  }

  /**
   * Get payroll report for a date range (Admin/Owner only)
   */
  @Get("payroll")
  @Roles(UserRole.owner, UserRole.admin)
  async getPayrollReport(
    @CurrentUser() user: any,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
  ) {
    return this.commissionsService.getPayrollReport(
      user.tenantId,
      new Date(startDate),
      new Date(endDate),
    );
  }
}
