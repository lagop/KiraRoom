import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { AnalyticsService } from "./analytics.service";
import {
  AnalyticsFlagsService,
  SubscriptionPlan } from "./analytics-flags.service";
import { Request } from "express";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
import { SalonPeriod, explicitPeriod, rangePeriod } from "./analytics-metrics";

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

/**
 * Analítica is the salon's figures: the owner's and admins' only (owner
 * decision 4a). Every route is SALON_MANAGERS; a staff account gets a 403.
 * Staff used to get their own figures through the overview and the status
 * counts, under titles that read as the salon's ("Ingresos totales").
 */
@ApiTags("Analytics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Roles(...SALON_MANAGERS)
@Controller("analytics")
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly analyticsFlagsService: AnalyticsFlagsService,
  ) {}

  private getPlan(request: AuthenticatedRequest): SubscriptionPlan {
    return (request.user.plan as SubscriptionPlan) || "basic";
  }

  private months(request: AuthenticatedRequest, months: string | undefined, fallback = 6): number {
    const requested = months ? parseInt(months, 10) : fallback;
    return this.analyticsFlagsService.clampMonths(
      this.getPlan(request),
      Number.isFinite(requested) && requested > 0 ? requested : fallback,
    );
  }

  private datesOrThrow(startDate?: string, endDate?: string): SalonPeriod {
    const period = explicitPeriod(startDate, endDate);
    if (!period) {
      throw new BadRequestException(
        "startDate y endDate deben ser fechas con formato AAAA-MM-DD.",
      );
    }
    return period;
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

  @Get("features")
  @ApiOperation({ summary: "Get analytics feature flags for current user" })
  @Roles(...SALON_MANAGERS)
  async getFeatureFlags(@Req() req: AuthenticatedRequest) {
    const plan = this.getPlan(req);
    return this.analyticsFlagsService.getFeatureFlags(plan);
  }

  @Get("overview")
  @ApiOperation({ summary: "Get analytics overview for dashboard" })
  @ApiQuery({ name: "months", required: false, type: Number })
  @Roles(...SALON_MANAGERS)
  async getOverview(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
  ) {
    return this.analyticsService.getOverview(req.user.tenantId, this.months(req, months));
  }

  @Get("revenue")
  @ApiOperation({ summary: "Get revenue report for date range" })
  @ApiQuery({ name: "startDate", required: true })
  @ApiQuery({ name: "endDate", required: true })
  @Roles(...SALON_MANAGERS)
  async getRevenueReport(
    @Req() req: AuthenticatedRequest,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
  ) {
    return this.analyticsService.getRevenueReport(
      req.user.tenantId,
      this.datesOrThrow(startDate, endDate),
    );
  }

  @Get("appointments")
  @ApiOperation({ summary: "Get appointments report for date range" })
  @ApiQuery({ name: "startDate", required: true })
  @ApiQuery({ name: "endDate", required: true })
  @Roles(...SALON_MANAGERS)
  async getAppointmentsReport(
    @Req() req: AuthenticatedRequest,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
  ) {
    return this.analyticsService.getAppointmentsReport(
      req.user.tenantId,
      this.datesOrThrow(startDate, endDate),
    );
  }

  @Get("appointment-status-evolution")
  @ApiOperation({ summary: "Get appointment status evolution over time" })
  @ApiQuery({ name: "status", required: true, type: String })
  @ApiQuery({ name: "months", required: false, type: Number })
  @Roles(...SALON_MANAGERS)
  async getAppointmentStatusEvolution(
    @Req() req: AuthenticatedRequest,
    @Query("status") status: string,
    @Query("months") months?: string,
  ) {
    return this.analyticsService.getAppointmentStatusEvolution(
      req.user.tenantId,
      status,
      this.months(req, months),
    );
  }

  @Get("appointment-statuses-evolution")
  @ApiOperation({
    summary:
      "Get all appointment statuses evolution over time (stacked chart data)" })
  @ApiQuery({ name: "months", required: false, type: Number })
  @Roles(...SALON_MANAGERS)
  async getAppointmentStatusesEvolution(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
  ) {
    return this.analyticsService.getAppointmentStatusesEvolution(
      req.user.tenantId,
      this.months(req, months),
    );
  }

  @Get("appointment-status-by-days")
  @ApiOperation({ summary: "Get appointment status by number of days" })
  @ApiQuery({ name: "days", required: false, type: Number })
  @Roles(...SALON_MANAGERS)
  async getAppointmentStatusByDays(
    @Req() req: AuthenticatedRequest,
    @Query("days") days?: string,
  ) {
    return this.analyticsService.getAppointmentStatusByDays(
      req.user.tenantId,
      days ? parseInt(days, 10) : 7,
    );
  }

  @Get("appointment-rates")
  @ApiOperation({
    summary:
      "Completion, cancellation and no-show rates over closed appointments up to yesterday (last `days` days, or last `months` months with a per-month breakdown)" })
  @ApiQuery({ name: "days", required: false, type: Number })
  @ApiQuery({ name: "months", required: false, type: Number })
  @Roles(...SALON_MANAGERS)
  async getAppointmentRates(
    @Req() req: AuthenticatedRequest,
    @Query("days") days?: string,
    @Query("months") months?: string,
  ) {
    if (months) {
      return this.analyticsService.getAppointmentRates(req.user.tenantId, {
        months: this.months(req, months),
      });
    }
    const n = days ? parseInt(days, 10) : 7;
    return this.analyticsService.getAppointmentRates(req.user.tenantId, {
      days: Number.isFinite(n) && n > 0 ? n : 7,
    });
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
  @Roles(...SALON_MANAGERS)
  async getDetailedReport(
    @Req() req: AuthenticatedRequest,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
    @Query("type") type?: string,
  ) {
    // Check advanced access
    this.checkAdvancedAccess(req, "Detailed reports");

    const tenantId = req.user.tenantId;
    const period = this.datesOrThrow(startDate, endDate);
    const reportType = type || "both";

    const result: any = {};

    if (reportType === "revenue" || reportType === "both") {
      result.revenue = await this.analyticsService.getRevenueReport(tenantId, period);
    }

    if (reportType === "appointments" || reportType === "both") {
      result.appointments = await this.analyticsService.getAppointmentsReport(
        tenantId,
        period,
      );
    }

    return result;
  }

  @Get("professional-performance")
  @Feature("advanced_analytics")
  @ApiOperation({
    summary: "Get performance metrics per professional (paid feature)" })
  @ApiQuery({ name: "range", required: false, type: String })
  @Roles(...SALON_MANAGERS)
  async getProfessionalPerformance(
    @Req() req: AuthenticatedRequest,
    @Query("range") range?: string,
  ) {
    // Check advanced access
    this.checkAdvancedAccess(req, "Professional performance");

    const tenantId = req.user.tenantId;
    const maxMonths = this.analyticsFlagsService.getMaxMonths(this.getPlan(req));
    // "Today", "this week"... are the salon's, not the server's (UTC).
    const { today } = await this.analyticsService.todayFor(tenantId);
    const period = rangePeriod(range ?? "3_months", today, maxMonths);

    return this.analyticsService.getTopProfessionals(tenantId, period, 10);
  }

  @Get("client-insights")
  @Feature("advanced_analytics")
  @ApiOperation({
    summary: "Get client insights and retention metrics (paid feature)" })
  @ApiQuery({ name: "months", required: false, type: Number })
  @Roles(...SALON_MANAGERS)
  async getClientInsights(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
  ) {
    // Check advanced access
    this.checkAdvancedAccess(req, "Client insights");

    return this.analyticsService.getClientInsights(
      req.user.tenantId,
      this.months(req, months),
    );
  }
}
