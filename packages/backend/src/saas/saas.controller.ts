import { ParseUUIDPipe, Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus, Req } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { SaasService, PaginatedResult } from "./saas.service";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { TenantFilterDto } from "./dto/tenant-filter.dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SaasOwnerGuard } from "./guards/saas-owner.guard";
import { SaasOwner } from "./decorators/saas-owner.decorator";
import { UserRole } from "@prisma/client";

@ApiTags("SaaS Management")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SaasOwnerGuard)
@SaasOwner()
@Controller("saas")
export class SaasController {
  constructor(private readonly saasService: SaasService) {}

  @Get("tenants")
  @ApiOperation({ summary: "Get all tenants (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "List of tenants with pagination" })
  async getAllTenants(@Query() filter: TenantFilterDto): Promise<PaginatedResult<any>> {
    return this.saasService.getAllTenants(filter);
  }

  @Get("tenants/:id")
  @ApiOperation({ summary: "Get tenant by ID (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Tenant details" })
  @ApiResponse({ status: 404, description: "Tenant not found" })
  async getTenantById(@Param("id", ParseUUIDPipe) id: string) {
    return this.saasService.getTenantById(id);
  }

  @Post("tenants")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a new tenant (SaaS Owner only)" })
  @ApiResponse({ status: 201, description: "Tenant created successfully" })
  @ApiResponse({ status: 400, description: "Invalid input or slug already exists" })
  async createTenant(@Body() createTenantDto: CreateTenantDto) {
    return this.saasService.createTenant(createTenantDto);
  }

  @Patch("tenants/:id")
  @ApiOperation({ summary: "Update tenant (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Tenant updated successfully" })
  @ApiResponse({ status: 404, description: "Tenant not found" })
  async updateTenant(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateTenantDto: UpdateTenantDto,
  ) {
    return this.saasService.updateTenant(id, updateTenantDto);
  }

  @Delete("tenants/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete tenant (SaaS Owner only, soft-delete)" })
  @ApiResponse({ status: 200, description: "Tenant soft-deleted successfully" })
  @ApiResponse({ status: 404, description: "Tenant not found" })
  async deleteTenant(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.saasService.deleteTenant(id, req.user.id);
  }

  @Get("tenants/:id/stats")
  @ApiOperation({ summary: "Get tenant statistics (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Tenant statistics" })
  async getTenantStats(@Param("id", ParseUUIDPipe) id: string) {
    return this.saasService.getTenantStats(id);
  }

  @Get("tenants/:id/progress")
  @ApiOperation({
    summary: "Get per-tenant onboarding progress score (SaaS Owner only)",
  })
  @ApiResponse({ status: 200, description: "Progress score 0..1 + per-component breakdown" })
  async getTenantProgress(@Param("id", ParseUUIDPipe) id: string) {
    return this.saasService.getTenantProgress(id);
  }

  @Post("tenants/:id/suspend")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Suspend tenant (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Tenant suspended successfully" })
  async suspendTenant(@Param("id", ParseUUIDPipe) id: string) {
    return this.saasService.suspendTenant(id);
  }

  @Post("tenants/:id/reactivate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reactivate tenant (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Tenant reactivated successfully" })
  async reactivateTenant(@Param("id", ParseUUIDPipe) id: string) {
    return this.saasService.reactivateTenant(id);
  }

  @Get("analytics/overview")
  @ApiOperation({ summary: "Get platform-wide analytics (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Platform analytics" })
  async getPlatformAnalytics() {
    return this.saasService.getPlatformAnalytics();
  }

  @Get("tenants/:id/growth")
  @ApiOperation({ summary: "Get tenant growth metrics (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Tenant growth metrics with evolution" })
  async getTenantGrowthMetrics(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("months") months?: string,
  ) {
    const monthsNum = months ? parseInt(months, 10) : 6;
    return this.saasService.getSalonGrowthMetrics(id, monthsNum);
  }

  @Get("analytics/growth")
  @ApiOperation({ summary: "Get platform growth metrics (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Platform growth metrics with evolution" })
  async getPlatformGrowthMetrics(@Query("months") months?: string) {
    const monthsNum = months ? parseInt(months, 10) : 6;
    return this.saasService.getPlatformGrowthMetrics(monthsNum);
  }

  @Get("users")
  @ApiOperation({ summary: "Get all users across tenants (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "List of users with pagination" })
  async getAllUsers(@Query() filter: TenantFilterDto): Promise<PaginatedResult<any>> {
    return this.saasService.getAllUsers(filter);
  }

  @Post("tenants/:id/launch")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Launch salon dashboard as owner (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Returns impersonation token + owner info; consume via POST /auth/impersonate" })
  @ApiResponse({ status: 404, description: "Tenant not found" })
  async launchSalonDashboard(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.saasService.launchSalonDashboard(id, req.user.id);
  }
}