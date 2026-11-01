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
import { AnalyticsFlagsService } from "./analytics-flags.service";
import { Request } from "express";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
import { PeriodWindow, RANGE_KEYS, parseRangeKey, rangePeriod } from "./analytics-metrics";
import { LocationScope, isLocationId } from "./analytics-location";

const RANGE_MESSAGE = `El período no es válido. Usa uno de: ${RANGE_KEYS.join(", ")}.`;
const RANGE_DESCRIPTION = `A named period of the salon calendar (${RANGE_KEYS.join(", ")}), cut to the plan's months. Takes precedence over months.`;
const LOCATION_DESCRIPTION =
  "Empresa: only this location (appointments booked there, or by its professionals when the booking has none; till services by its professionals). 400 malformed, 403 on other plans, 404 for another salon's location.";

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

  /**
   * The period asked for: a named `range` (this_month, last_month,
   * last_30_days, 3_months...) cut to the plan's months, or else the last
   * `months` months as before. An unknown range is a 400, not this month.
   */
  private async window(
    request: AuthenticatedRequest,
    range: string | undefined,
    months: string | undefined,
  ): Promise<PeriodWindow> {
    if (range === undefined || range === "") return this.months(request, months);
    const key = parseRangeKey(range);
    if (!key) throw new BadRequestException(RANGE_MESSAGE);
    return { range: key, maxMonths: await this.analyticsFlagsService.getMaxMonths(request.user.tenantId) };
  }

  /**
   * The location filter (Empresa, D12): none without `locationId`; a 400 for
   * a malformed id, a 403 when the plan has no per-location reports, a 404
   * when the location is not this salon's.
   */
  private async scope(request: AuthenticatedRequest, locationId: string | undefined): Promise<LocationScope | undefined> {
    if (locationId === undefined || locationId === "") return undefined;
    if (!isLocationId(locationId)) throw new BadRequestException("El local no es válido.");
    const tenantId = request.user.tenantId;
    if (!(await this.analyticsFlagsService.hasLocationFilter(tenantId))) {
      throw new ForbiddenException({
        code: "FEATURE_NOT_IN_PLAN",
        message: "Ver la analítica por local está disponible en el plan Empresa.",
        upgradeUrl: "/dashboard/billing",
      });
    }
    return this.analyticsService.locationScope(tenantId, locationId);
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
  @ApiQuery({ name: "range", required: false, type: String, description: RANGE_DESCRIPTION })
  @ApiQuery({ name: "locationId", required: false, type: String, description: LOCATION_DESCRIPTION })
  @Roles(...SALON_MANAGERS)
  async getOverview(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
    @Query("range") range?: string,
    @Query("locationId") locationId?: string,
  ) {
    const [window, scope] = await Promise.all([this.window(req, range, months), this.scope(req, locationId)]);
    return this.analyticsService.getOverview(req.user.tenantId, window, scope);
  }

  @Get("appointment-statuses-evolution")
  @ApiOperation({
    summary:
      "Get all appointment statuses evolution over time (stacked chart data)" })
  @ApiQuery({ name: "months", required: false, type: Number })
  @ApiQuery({ name: "locationId", required: false, type: String, description: LOCATION_DESCRIPTION })
  @Roles(...SALON_MANAGERS)
  async getAppointmentStatusesEvolution(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
    @Query("locationId") locationId?: string,
  ) {
    const [n, scope] = await Promise.all([this.months(req, months), this.scope(req, locationId)]);
    return this.analyticsService.getAppointmentStatusesEvolution(req.user.tenantId, n, scope);
  }

  @Get("appointment-status-by-days")
  @ApiOperation({ summary: "Get appointment status by number of days" })
  @ApiQuery({ name: "days", required: false, type: Number })
  @ApiQuery({ name: "locationId", required: false, type: String, description: LOCATION_DESCRIPTION })
  @Roles(...SALON_MANAGERS)
  async getAppointmentStatusByDays(
    @Req() req: AuthenticatedRequest,
    @Query("days") days?: string,
    @Query("locationId") locationId?: string,
  ) {
    const scope = await this.scope(req, locationId);
    return this.analyticsService.getAppointmentStatusByDays(
      req.user.tenantId,
      days ? parseInt(days, 10) : 7,
      scope,
    );
  }

  @Get("appointment-rates")
  @ApiOperation({
    summary:
      "Completion, cancellation and no-show rates over closed appointments up to yesterday (last `days` days, or last `months` months with a per-month breakdown)" })
  @ApiQuery({ name: "days", required: false, type: Number })
  @ApiQuery({ name: "months", required: false, type: Number })
  @ApiQuery({ name: "locationId", required: false, type: String, description: LOCATION_DESCRIPTION })
  @Roles(...SALON_MANAGERS)
  async getAppointmentRates(
    @Req() req: AuthenticatedRequest,
    @Query("days") days?: string,
    @Query("months") months?: string,
    @Query("locationId") locationId?: string,
  ) {
    const scope = await this.scope(req, locationId);
    if (months) {
      return this.analyticsService.getAppointmentRates(
        req.user.tenantId,
        { months: await this.months(req, months) },
        scope,
      );
    }
    const n = days ? parseInt(days, 10) : 7;
    return this.analyticsService.getAppointmentRates(
      req.user.tenantId,
      { days: Number.isFinite(n) && n > 0 ? n : 7 },
      scope,
    );
  }

  @Get("professional-performance")
  @Feature("advanced_analytics")
  @ApiOperation({
    summary: "Get performance metrics per professional (Pro and Empresa)" })
  @ApiQuery({ name: "range", required: false, type: String, description: RANGE_DESCRIPTION })
  @ApiQuery({ name: "locationId", required: false, type: String, description: LOCATION_DESCRIPTION })
  @Roles(...SALON_MANAGERS)
  async getProfessionalPerformance(
    @Req() req: AuthenticatedRequest,
    @Query("range") range?: string,
    @Query("locationId") locationId?: string,
  ) {
    const tenantId = req.user.tenantId;
    const key = range === undefined || range === "" ? "3_months" : parseRangeKey(range);
    if (!key) throw new BadRequestException(RANGE_MESSAGE);
    const [maxMonths, scope, { today }] = await Promise.all([
      this.analyticsFlagsService.getMaxMonths(tenantId),
      this.scope(req, locationId),
      // "Today", "this week"... are the salon's, not the server's (UTC).
      this.analyticsService.todayFor(tenantId),
    ]);
    const period = rangePeriod(key, today, maxMonths);

    return this.analyticsService.getTopProfessionals(tenantId, period, 10, scope);
  }

  @Get("client-insights")
  @Feature("advanced_analytics")
  @ApiOperation({
    summary: "Get client insights and retention metrics (Pro and Empresa)" })
  @ApiQuery({ name: "months", required: false, type: Number })
  @ApiQuery({ name: "range", required: false, type: String, description: RANGE_DESCRIPTION })
  @ApiQuery({ name: "locationId", required: false, type: String, description: LOCATION_DESCRIPTION })
  @Roles(...SALON_MANAGERS)
  async getClientInsights(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
    @Query("range") range?: string,
    @Query("locationId") locationId?: string,
  ) {
    const [window, scope] = await Promise.all([this.window(req, range, months), this.scope(req, locationId)]);
    return this.analyticsService.getClientInsights(req.user.tenantId, window, scope);
  }
}
