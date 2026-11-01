import { ParseUUIDPipe, Controller, Get, Post, Put, Delete, Body, Param, Query, Req, UseGuards, NotFoundException } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { Public } from "../auth/decorators/public.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";
import { PublicViewerService } from "../common/tenancy/public-viewer.service";
import { ProfessionalsService, seesFullRows } from "./professionals.service";
import { CreateProfessionalDto, UpdateProfessionalDto } from "./dto";
import { OnboardingDetectorService } from "../onboarding/onboarding-detector.service";
import { AdminProfessionalsService } from "../admin/professionals/professionals.service";

/**
 * The panel reads and writes professionals through /admin/professionals.
 * The writes here (POST/PUT/DELETE) are kept for API callers (the E2E
 * suite creates its professional with POST) and go through the same
 * AdminProfessionalsService: the plan's limit under the salon's lock, the
 * login revoked on deactivation, Spanish errors. They used to have their
 * own copy of that logic, which drifted.
 */
@ApiTags("professionals")
@Controller("professionals")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ProfessionalsController {
  constructor(
    private readonly professionalsService: ProfessionalsService,
    private readonly onboardingDetector: OnboardingDetectorService,
    private readonly publicViewer: PublicViewerService,
    private readonly adminProfessionals: AdminProfessionalsService,
  ) {}

  @Post()
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Create a new professional" })
  @ApiResponse({
    status: 201,
    description: "Professional created successfully",
  })
  async create(@CurrentUser() user: any, @Body() createProfessionalDto: CreateProfessionalDto) {
    // The tenant comes from the caller's token, never from the body. Nobody
    // becomes "owner" through the API: that flag belongs to the salon's
    // main account.
    const { isOwner: _isOwner, ...fields } = createProfessionalDto;
    const pro = await this.adminProfessionals.create({ ...fields, tenantId: user.tenantId });
    // After the first working-hours change, the schedule_set step becomes
    // eligible. Re-detect asynchronously.
    void this.onboardingDetector
      .detect(user.tenantId, "schedule_set")
      .catch(() => undefined);
    return pro;
  }

  @Get()
  @Public()
  @ApiOperation({ summary: "Get all professionals with optional filters" })
  async findAll(@Req() req: any, @Query("tenantId") tenantId?: string) {
    // Never unscoped, and full rows only for the salon's owner and admins
    // (a professional gets their own): see PublicViewerService.
    const viewer = await this.publicViewer.resolve(req, tenantId);
    return this.professionalsService.findAll(viewer.tenantId, viewer);
  }

  @Get(":id")
  @Public()
  @ApiOperation({ summary: "Get professional by ID" })
  @ApiResponse({ status: 200, description: "Professional found" })
  @ApiResponse({ status: 404, description: "Professional not found" })
  async findOne(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    const professional = await this.professionalsService.findOne(id);
    // Anyone holding a professional's id (it is in ICS and QR URLs) used to
    // get the full row. The salon's owner and admins still do, and a
    // professional their own; other staff get the public projection (also
    // of an inactive colleague, who is on past appointments); everyone else
    // too, and an inactive professional is not public.
    const viewer = await this.publicViewer.resolve(req, professional.tenantId);
    if (seesFullRows(viewer)) return professional;
    if (viewer.staff) {
      return viewer.userId && professional.userId === viewer.userId
        ? professional
        : this.professionalsService.toPublic(professional);
    }
    if (!professional.isActive) throw new NotFoundException("Profesional no encontrado");
    return this.professionalsService.toPublic(professional);
  }

  @Put(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Update a professional" })
  @ApiResponse({
    status: 200,
    description: "Professional updated successfully",
  })
  @ApiResponse({ status: 404, description: "Professional not found" })
  async update(
    @CurrentUser() user: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateProfessionalDto: UpdateProfessionalDto,
  ) {
    const { isOwner: _isOwner, ...fields } = updateProfessionalDto;
    // Scoped to the caller's salon (it used to look the id up anywhere).
    const pro = await this.adminProfessionals.update(user.tenantId, id, fields);
    void this.onboardingDetector
      .detect(user.tenantId, "schedule_set")
      .catch(() => undefined);
    return pro;
  }

  @Delete(":id")
  @Roles(UserRole.owner)
  @ApiOperation({ summary: "Delete a professional (Owner only)" })
  @ApiResponse({
    status: 200,
    description: "Professional deleted successfully",
  })
  @ApiResponse({ status: 404, description: "Professional not found" })
  async remove(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminProfessionals.remove(user.tenantId, id);
  }
}
