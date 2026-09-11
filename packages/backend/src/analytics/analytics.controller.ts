import { Controller, Get, Query, UseGuards, Req, ForbiddenException } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { AnalyticsService } from "./analytics.service";
import {
  AnalyticsFlagsService,
  SubscriptionPlan } from "./analytics-flags.service";
import { ProfessionalsService } from "../professionals/professionals.service";
import { Request } from "express";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    tenantId: string;
    role: string;
    userId: string;
    plan?: string;
    subscriptionStatus?: string;
  };
}

@ApiTags("Analytics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Controller("analytics")
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly analyticsFlagsService: AnalyticsFlagsService,
    private readonly professionalsService: ProfessionalsService,
  ) {}

  private getPlan(request: AuthenticatedRequest): SubscriptionPlan {
    return (request.user.plan as SubscriptionPlan) || "basic";
  }

  private checkAdvancedAccess(
    request: AuthenticatedRequest,
    feature: string,
  ): void {
    const plan = this.getPlan(request);
    if (!this.analyticsFlagsService.hasAdvancedAnalytics(plan)) {
      throw new ForbiddenException({
        message: `${feature} requires a paid plan`,
        upgradeRequired: true,
        currentPlan: plan,
        requiredPlan: "professional" });
    }
  }

  private async getProfessionalIdForStaff(
    req: AuthenticatedRequest,
  ): Promise<string | null> {
    if (req.user.role === "staff") {
      const professional =
        await this.professionalsService.getProfessionalByUserId(
          req.user.id,
          req.user.tenantId,
        );
      return professional?.id || null;
    }
    return null;
  }

  @Get("features")
  @ApiOperation({ summary: "Get analytics feature flags for current user" })
  async getFeatureFlags(@Req() req: AuthenticatedRequest) {
    const plan = this.getPlan(req);
    return this.analyticsFlagsService.getFeatureFlags(plan);
  }

  @Get("overview")
  @ApiOperation({ summary: "Get analytics overview for dashboard" })
  @ApiQuery({ name: "months", required: false, type: Number })
  async getOverview(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
  ) {
    const tenantId = req.user.tenantId;
    const plan = this.getPlan(req);
    const requestedMonths = months ? parseInt(months, 10) : 6;

    // Clamp months to plan limit
    const monthsNum = this.analyticsFlagsService.clampMonths(
      plan,
      requestedMonths,
    );

    // Aplicar filtro por profesional para Staff
    const professionalId = await this.getProfessionalIdForStaff(req);

    return this.analyticsService.getOverview(
      tenantId,
      monthsNum,
      professionalId,
    );
  }

  @Get("revenue")
  @ApiOperation({ summary: "Get revenue report for date range" })
  @ApiQuery({ name: "startDate", required: true })
  @ApiQuery({ name: "endDate", required: true })
  async getRevenueReport(
    @Req() req: AuthenticatedRequest,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.analyticsService.getRevenueReport(tenantId, startDate, endDate);
  }

  @Get("appointments")
  @ApiOperation({ summary: "Get appointments report for date range" })
  @ApiQuery({ name: "startDate", required: true })
  @ApiQuery({ name: "endDate", required: true })
  async getAppointmentsReport(
    @Req() req: AuthenticatedRequest,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.analyticsService.getAppointmentsReport(
      tenantId,
      startDate,
      endDate,
    );
  }

  @Get("appointment-status-evolution")
  @ApiOperation({ summary: "Get appointment status evolution over time" })
  @ApiQuery({ name: "status", required: true, type: String })
  @ApiQuery({ name: "months", required: false, type: Number })
  async getAppointmentStatusEvolution(
    @Req() req: AuthenticatedRequest,
    @Query("status") status: string,
    @Query("months") months?: string,
  ) {
    const tenantId = req.user.tenantId;
    const monthsNum = months ? parseInt(months, 10) : 6;
    return this.analyticsService.getAppointmentStatusEvolution(
      tenantId,
      status,
      monthsNum,
    );
  }

  @Get("appointment-statuses-evolution")
  @ApiOperation({
    summary:
      "Get all appointment statuses evolution over time (stacked chart data)" })
  @ApiQuery({ name: "months", required: false, type: Number })
  async getAppointmentStatusesEvolution(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
  ) {
    const tenantId = req.user.tenantId;
    const plan = this.getPlan(req);
    const requestedMonths = months ? parseInt(months, 10) : 6;
    const monthsNum = this.analyticsFlagsService.clampMonths(
      plan,
      requestedMonths,
    );
    return this.analyticsService.getAppointmentStatusesEvolution(
      tenantId,
      monthsNum,
    );
  }

  @Get("appointment-status-by-days")
  @ApiOperation({ summary: "Get appointment status by number of days" })
  @ApiQuery({ name: "days", required: false, type: Number })
  async getAppointmentStatusByDays(
    @Req() req: AuthenticatedRequest,
    @Query("days") days?: string,
  ) {
    const tenantId = req.user.tenantId;
    const daysNum = days ? parseInt(days, 10) : 7;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    return this.analyticsService.getAppointmentStatus(
      tenantId,
      startDate,
      endDate,
    );
  }

  @Get("detailed-report")
  @Feature("advanced_analytics")
  @ApiOperation({ summary: "Get detailed analytics report (paid feature)" })
  @ApiQuery({ name: "startDate", required: true })
  @ApiQuery({ name: "endDate", required: true })
  @ApiQuery({
    name: "type",
    required: false,
    enum: ["revenue", "appointments", "both"] })
  async getDetailedReport(
    @Req() req: AuthenticatedRequest,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
    @Query("type") type?: string,
  ) {
    // Check advanced access
    this.checkAdvancedAccess(req, "Detailed reports");

    const tenantId = req.user.tenantId;
    const reportType = type || "both";

    const result: any = {};

    if (reportType === "revenue" || reportType === "both") {
      result.revenue = await this.analyticsService.getRevenueReport(
        tenantId,
        startDate,
        endDate,
      );
    }

    if (reportType === "appointments" || reportType === "both") {
      result.appointments = await this.analyticsService.getAppointmentsReport(
        tenantId,
        startDate,
        endDate,
      );
    }

    return result;
  }

  @Get("professional-performance")
  @Feature("advanced_analytics")
  @ApiOperation({
    summary: "Get performance metrics per professional (paid feature)" })
  @ApiQuery({ name: "range", required: false, type: String })
  async getProfessionalPerformance(
    @Req() req: AuthenticatedRequest,
    @Query("range") range?: string,
  ) {
    // Check advanced access
    this.checkAdvancedAccess(req, "Professional performance");

    const tenantId = req.user.tenantId;
    const plan = this.getPlan(req);

    // Parse time range
    const { startDate, endDate } = this.parseTimeRange(range, plan);

    return this.analyticsService.getTopProfessionals(
      tenantId,
      startDate,
      endDate,
      10,
    );
  }

  /**
   * Parse time range string into dates
   */
  private parseTimeRange(
    range: string | undefined,
    plan: SubscriptionPlan,
  ): { startDate: Date; endDate: Date } {
    const now = new Date();
    const today = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
    );
    let startDate: Date;
    let endDate: Date = today;

    switch (range) {
      case "today":
        startDate = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          0,
          0,
          0,
        );
        break;
      case "this_week":
        // Start of week (Monday)
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        startDate = new Date(now);
        startDate.setDate(now.getDate() + mondayOffset);
        startDate.setHours(0, 0, 0, 0);
        break;
      case "last_week":
        const lastWeekDay = now.getDay();
        const lastMondayOffset = lastWeekDay === 0 ? -13 : -6 - lastWeekDay;
        startDate = new Date(now);
        startDate.setDate(now.getDate() + lastMondayOffset);
        startDate.setHours(0, 0, 0, 0);
        endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6);
        endDate.setHours(23, 59, 59, 999);
        break;
      case "this_month":
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case "last_month":
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
        break;
      case "3_months":
        startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
        break;
      case "6_months":
        startDate = new Date(now.getFullYear(), now.getMonth() - 6, 1);
        break;
      case "1_year":
      case "12_months":
        startDate = new Date(now.getFullYear() - 1, now.getMonth(), 1);
        break;
      default:
        // Default to 3 months or max allowed by plan
        const maxMonths = this.analyticsFlagsService.getMaxMonths(plan);
        startDate = new Date(
          now.getFullYear(),
          now.getMonth() - Math.min(maxMonths, 3),
          1,
        );
    }

    return { startDate, endDate };
  }

  @Get("client-insights")
  @Feature("advanced_analytics")
  @ApiOperation({
    summary: "Get client insights and retention metrics (paid feature)" })
  @ApiQuery({ name: "months", required: false, type: Number })
  async getClientInsights(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
  ) {
    // Check advanced access
    this.checkAdvancedAccess(req, "Client insights");

    const tenantId = req.user.tenantId;
    const plan = this.getPlan(req);
    const requestedMonths = months ? parseInt(months, 10) : 6;
    const monthsNum = this.analyticsFlagsService.clampMonths(
      plan,
      requestedMonths,
    );

    const now = new Date();
    const startDate = new Date(
      now.getFullYear(),
      now.getMonth() - monthsNum,
      1,
    );

    // Get client retention data
    const newClients = await this.analyticsService.getNewClientsCount(
      tenantId,
      startDate,
      now,
    );
    const totalAppointments = await this.analyticsService.getAppointmentCount(
      tenantId,
      startDate,
      now,
    );

    // Calculate returning clients (simplified - actual implementation would track client appointment history)
    const returningClients = Math.floor(totalAppointments * 0.4); // Placeholder calculation

    return {
      newClients,
      returningClients,
      totalAppointments,
      retentionRate:
        totalAppointments > 0
          ? Math.round((returningClients / totalAppointments) * 100)
          : 0,
      period: `${monthsNum} months` };
  }
}
