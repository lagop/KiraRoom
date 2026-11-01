import {
  Controller,
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
import { AnalyticsFlagsService } from "./analytics-flags.service";
import { Request } from "express";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
import { rangePeriod } from "./analytics-metrics";

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    tenantId: string;
    role: string;
    userId: string;
  };
}

/**
 * Analítica is the salon's figures: the owner's and admins' only (owner
 * decision 4a). Every route is SALON_MANAGERS, so a staff account gets a
 * 403. Staff used to get their own figures through the overview and the
 * status counts, under titles that read as the salon's ("Ingresos totales").
 *
 * The plan gate is FeatureGuard (@Feature("advanced_analytics")), which reads
 * the effective plan: a trial counts as Pro. History limits come from the same
 * effective plan via AnalyticsFlagsService. There is no second, JWT-based plan
 * check here any more: it refused trials the guard had let through.
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

  /** The requested months, cut to the plan's history. */
  private months(request: AuthenticatedRequest, months: string | undefined, fallback = 6) {
    return this.analyticsFlagsService.clampMonths(
      request.user.tenantId,
      months ? parseInt(months, 10) : fallback,
      fallback,
    );
  }

  @Get("features")
  @ApiOperation({
    summary:
      "What the analytics page may show for this user (effective plan and role)" })
  @Roles(...SALON_MANAGERS)
  async getFeatureFlags(@Req() req: AuthenticatedRequest) {
    return this.analyticsFlagsService.getFeatureFlags(req.user.tenantId, req.user.role);
  }

  @Get("overview")
  @ApiOperation({ summary: "Get analytics overview for dashboard" })
  @ApiQuery({ name: "months", required: false, type: Number })
  @Roles(...SALON_MANAGERS)
  async getOverview(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
  ) {
    return this.analyticsService.getOverview(req.user.tenantId, await this.months(req, months));
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
      await this.months(req, months),
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
        months: await this.months(req, months),
      });
    }
    const n = days ? parseInt(days, 10) : 7;
    return this.analyticsService.getAppointmentRates(req.user.tenantId, {
      days: Number.isFinite(n) && n > 0 ? n : 7,
    });
  }

  @Get("professional-performance")
  @Feature("advanced_analytics")
  @ApiOperation({
    summary: "Get performance metrics per professional (Pro and Empresa)" })
  @ApiQuery({ name: "range", required: false, type: String })
  @Roles(...SALON_MANAGERS)
  async getProfessionalPerformance(
    @Req() req: AuthenticatedRequest,
    @Query("range") range?: string,
  ) {
    const tenantId = req.user.tenantId;
    const maxMonths = await this.analyticsFlagsService.getMaxMonths(tenantId);
    // "Today", "this week"... are the salon's, not the server's (UTC).
    const { today } = await this.analyticsService.todayFor(tenantId);
    const period = rangePeriod(range ?? "3_months", today, maxMonths);

    return this.analyticsService.getTopProfessionals(tenantId, period, 10);
  }

  @Get("client-insights")
  @Feature("advanced_analytics")
  @ApiOperation({
    summary: "Get client insights and retention metrics (Pro and Empresa)" })
  @ApiQuery({ name: "months", required: false, type: Number })
  @Roles(...SALON_MANAGERS)
  async getClientInsights(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
  ) {
    return this.analyticsService.getClientInsights(
      req.user.tenantId,
      await this.months(req, months),
    );
  }
}
