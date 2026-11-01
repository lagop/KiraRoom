import {
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
import { Roles, SALON_TEAM, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { AnalyticsService } from "./analytics.service";
import { AnalyticsFlagsService } from "./analytics-flags.service";
import { ProfessionalsService } from "../professionals/professionals.service";
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
 * The plan gate is FeatureGuard (@Feature("advanced_analytics")), which reads
 * the effective plan: a trial counts as Pro. History limits come from the same
 * effective plan via AnalyticsFlagsService. There is no second, JWT-based plan
 * check here any more: it refused trials the guard had let through.
 */
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

  /** The requested months, cut to the plan's history. */
  private months(request: AuthenticatedRequest, months: string | undefined, fallback = 6) {
    return this.analyticsFlagsService.clampMonths(
      request.user.tenantId,
      months ? parseInt(months, 10) : fallback,
      fallback,
    );
  }

  /**
   * null for the owner and admins (the whole salon); for staff, their own
   * professional. A staff account linked to no professional used to get
   * null too -- read as "no filter" -- and so saw the whole salon's figures.
   * Now it is refused, as clients and appointments are for such an account.
   */
  private async getProfessionalIdForStaff(
    req: AuthenticatedRequest,
  ): Promise<string | null> {
    if (req.user.role !== "staff") return null;
    const professional =
      await this.professionalsService.getProfessionalByUserId(
        req.user.id,
        req.user.tenantId,
      );
    if (!professional) {
      throw new ForbiddenException(
        "Tu cuenta no está vinculada a ninguna ficha de profesional. Pide a quien gestiona el salón que lo revise.",
      );
    }
    return professional.id;
  }

  @Get("features")
  @ApiOperation({
    summary:
      "What the analytics page may show for this user (effective plan and role)" })
  @Roles(...SALON_TEAM)
  async getFeatureFlags(@Req() req: AuthenticatedRequest) {
    return this.analyticsFlagsService.getFeatureFlags(req.user.tenantId, req.user.role);
  }

  @Get("overview")
  @ApiOperation({ summary: "Get analytics overview for dashboard" })
  @ApiQuery({ name: "months", required: false, type: Number })
  @Roles(...SALON_TEAM)
  async getOverview(
    @Req() req: AuthenticatedRequest,
    @Query("months") months?: string,
  ) {
    // Staff: their own figures.
    const professionalId = await this.getProfessionalIdForStaff(req);
    return this.analyticsService.getOverview(
      req.user.tenantId,
      await this.months(req, months),
      professionalId,
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
      await this.months(req, months),
    );
  }

  @Get("appointment-status-by-days")
  @ApiOperation({ summary: "Get appointment status by number of days" })
  @ApiQuery({ name: "days", required: false, type: Number })
  @Roles(...SALON_TEAM)
  async getAppointmentStatusByDays(
    @Req() req: AuthenticatedRequest,
    @Query("days") days?: string,
  ) {
    // Staff: their own appointments, like the overview (this answered the
    // whole salon's to anyone on the team).
    const professionalId = await this.getProfessionalIdForStaff(req);
    return this.analyticsService.getAppointmentStatusByDays(
      req.user.tenantId,
      days ? parseInt(days, 10) : 7,
      professionalId,
    );
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
