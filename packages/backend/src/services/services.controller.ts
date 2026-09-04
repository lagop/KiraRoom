import { ParseUUIDPipe, Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { Public } from "../auth/decorators/public.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";
import { ServicesService } from "./services.service";
import { CreateServiceDto, UpdateServiceDto } from "./dto";
import { OnboardingDetectorService } from "../onboarding/onboarding-detector.service";

@ApiTags("services")
@Controller("services")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ServicesController {
  constructor(
    private readonly servicesService: ServicesService,
    private readonly onboardingDetector: OnboardingDetectorService,
  ) {}

  @Post()
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Create a new service" })
  @ApiResponse({ status: 201, description: "Service created successfully" })
  async create(@Body() createServiceDto: CreateServiceDto) {
    const service = await this.servicesService.create(createServiceDto);
    // Fire-and-forget: mark onboarding step done.
    void this.onboardingDetector
      .markStepCompleted(createServiceDto.tenantId, "service_create")
      .catch(() => undefined);
    return service;
  }

  @Get()
  @Public()
  @ApiOperation({ summary: "Get all services with optional filters" })
  async findAll(@Query("tenantId") tenantId?: string) {
    return this.servicesService.findAll(tenantId);
  }

  @Get(":id")
  @Public()
  @ApiOperation({ summary: "Get service by ID" })
  @ApiResponse({ status: 200, description: "Service found" })
  @ApiResponse({ status: 404, description: "Service not found" })
  async findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.servicesService.findOne(id);
  }

  @Put(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Update a service" })
  @ApiResponse({ status: 200, description: "Service updated successfully" })
  @ApiResponse({ status: 404, description: "Service not found" })
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateServiceDto: UpdateServiceDto,
  ) {
    return this.servicesService.update(id, updateServiceDto);
  }

  @Delete(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Delete a service" })
  @ApiResponse({ status: 200, description: "Service deleted successfully" })
  @ApiResponse({ status: 404, description: "Service not found" })
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.servicesService.remove(id);
  }
}
