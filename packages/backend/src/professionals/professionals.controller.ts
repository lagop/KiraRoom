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
import { ProfessionalsService } from "./professionals.service";
import { CreateProfessionalDto, UpdateProfessionalDto } from "./dto";
import { OnboardingDetectorService } from "../onboarding/onboarding-detector.service";

@ApiTags("professionals")
@Controller("professionals")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ProfessionalsController {
  constructor(
    private readonly professionalsService: ProfessionalsService,
    private readonly onboardingDetector: OnboardingDetectorService,
    private readonly publicViewer: PublicViewerService,
  ) {}

  @Post()
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Create a new professional" })
  @ApiResponse({
    status: 201,
    description: "Professional created successfully",
  })
  async create(@CurrentUser() user: any, @Body() createProfessionalDto: CreateProfessionalDto) {
    // The tenant comes from the caller's token, never from the body.
    const pro = await this.professionalsService.create(user.tenantId, createProfessionalDto);
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
    // Never unscoped, and full rows only for the salon's own staff: see
    // PublicViewerService for why this was a leak.
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
    // get the full row. Staff of that salon still do; everyone else gets the
    // public projection, and an inactive professional is not public.
    const { staff } = await this.publicViewer.resolve(req, professional.tenantId);
    if (staff) return professional;
    if (!professional.isActive) throw new NotFoundException(`Professional with ID ${id} not found`);
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
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateProfessionalDto: UpdateProfessionalDto,
  ) {
    const pro: any = await this.professionalsService.update(id, updateProfessionalDto);
    const tenantId = pro?.tenantId as string | undefined;
    if (tenantId) {
      void this.onboardingDetector
        .detect(tenantId, "schedule_set")
        .catch(() => undefined);
    }
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
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.professionalsService.remove(id);
  }
}
