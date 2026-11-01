import { ParseUUIDPipe, Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Logger } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { AdminProfessionalsService, MAX_PROFESSIONALS_PAGE } from "./professionals.service";
import {
  CreateProfessionalDto,
  UpdateProfessionalDto,
  ChangeProfessionalPasswordDto,
  GrantPanelAccessDto,
} from "./dto";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";

@ApiTags("Admin - Professionals")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.owner, UserRole.admin)
@Controller("admin/professionals")
export class AdminProfessionalsController {
  private readonly logger = new Logger(AdminProfessionalsController.name);

  constructor(
    private readonly adminProfessionalsService: AdminProfessionalsService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new professional" })
  @ApiResponse({
    status: 201,
    description: "Professional created successfully",
  })
  @ApiResponse({ status: 400, description: "Invalid input data" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async create(@CurrentUser() user: any, @Body() createProfessionalDto: CreateProfessionalDto) {
    // No body or record in the logs: they carry the professional's email,
    // phone and photo. The service logs what goes wrong.
    const professional = await this.adminProfessionalsService.create({
      ...createProfessionalDto,
      tenantId: user.tenantId,
    });
    this.logger.log(`Professional ${professional.id} created in tenant ${user.tenantId}`);
    return professional;
  }

  @Get()
  @ApiOperation({
    summary: "Get all professionals with pagination and filtering",
  })
  @ApiResponse({ status: 200, description: "List of professionals" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async findAll(
    @CurrentUser() user: any,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
    @Query("status") status?: string,
  ) {
    const pageNum = parseInt(page || "1", 10) || 1;
    // The whole team by default, up to MAX_PROFESSIONALS_PAGE. The default
    // was 10, and the panel asked for no limit, so the 11th professional
    // never showed up anywhere (team screen, wait list, QR, widget...).
    const requested = parseInt(limit || String(MAX_PROFESSIONALS_PAGE), 10) || MAX_PROFESSIONALS_PAGE;
    const limitNum = Math.min(Math.max(requested, 1), MAX_PROFESSIONALS_PAGE);
    return this.adminProfessionalsService.findAll({
      tenantId: user.tenantId,
      page: pageNum,
      limit: limitNum,
      search: search || "",
      status,
    });
  }

  @Get(":id")
  @ApiOperation({ summary: "Get professional by ID" })
  @ApiResponse({ status: 200, description: "Professional details" })
  @ApiResponse({ status: 404, description: "Professional not found" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async findOne(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminProfessionalsService.findOne(user.tenantId, id);
  }

  @Get(":id/upcoming-appointments")
  @ApiOperation({ summary: "How many appointments still to happen the professional has (before deactivating them)" })
  @ApiResponse({ status: 200, description: "{ count }" })
  async upcomingAppointments(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminProfessionalsService.upcomingAppointmentCount(user.tenantId, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update professional by ID" })
  @ApiResponse({
    status: 200,
    description: "Professional updated successfully",
  })
  @ApiResponse({ status: 404, description: "Professional not found" })
  @ApiResponse({ status: 400, description: "Invalid input data" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async update(
    @CurrentUser() user: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateProfessionalDto: UpdateProfessionalDto,
  ) {
    return this.adminProfessionalsService.update(user.tenantId, id, updateProfessionalDto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete professional by ID" })
  @ApiResponse({
    status: 200,
    description: "Professional deleted successfully",
  })
  @ApiResponse({ status: 404, description: "Professional not found" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async remove(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminProfessionalsService.remove(user.tenantId, id);
  }

  @Get("search/:query")
  @ApiOperation({ summary: "Search professionals by name, email, or phone" })
  @ApiResponse({ status: 200, description: "Search results" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async search(@CurrentUser() user: any, @Param("query") query: string) {
    return this.adminProfessionalsService.search(user.tenantId, query);
  }

  @Get(":id/availability")
  @ApiOperation({ summary: "Get professional availability" })
  @ApiResponse({ status: 200, description: "Professional availability data" })
  @ApiResponse({ status: 404, description: "Professional not found" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async getAvailability(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminProfessionalsService.getAvailability(user.tenantId, id);
  }

  @Patch(":id/password")
  @ApiOperation({ summary: "Change professional password" })
  @ApiResponse({ status: 200, description: "Password changed successfully" })
  @ApiResponse({ status: 404, description: "Professional not found" })
  @ApiResponse({ status: 400, description: "Invalid input data" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async changePassword(
    @CurrentUser() user: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() changePasswordDto: ChangeProfessionalPasswordDto,
  ) {
    return this.adminProfessionalsService.changePassword(user.tenantId, id, changePasswordDto);
  }

  @Post(":id/access")
  @ApiOperation({ summary: "Give a professional their own login to the panel, with a first password" })
  @ApiResponse({ status: 201, description: "Access granted" })
  @ApiResponse({ status: 409, description: "The email belongs to another account" })
  async grantAccess(
    @CurrentUser() user: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: GrantPanelAccessDto,
  ) {
    return this.adminProfessionalsService.grantPanelAccess(user.tenantId, id, dto.password);
  }

  @Delete(":id/access")
  @ApiOperation({ summary: "Remove a professional's login (deactivated, sessions ended)" })
  async revokeAccess(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminProfessionalsService.revokePanelAccess(user.tenantId, id);
  }
}
