import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Logger,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { AdminProfessionalsService } from "./professionals.service";
import {
  CreateProfessionalDto,
  UpdateProfessionalDto,
  ChangeProfessionalPasswordDto,
} from "./dto";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";
import { ValidationError } from "class-validator";

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
  async create(@Body() createProfessionalDto: CreateProfessionalDto) {
    this.logger.log(
      "Creating professional with data:",
      JSON.stringify(createProfessionalDto),
    );
    try {
      const professional = await this.adminProfessionalsService.create(
        createProfessionalDto,
      );
      this.logger.log(
        "Professional created successfully:",
        JSON.stringify(professional),
      );
      return professional;
    } catch (error) {
      this.logger.error("Error creating professional:", error);

      // Log validation errors more clearly
      if (
        error.response &&
        error.response.message &&
        Array.isArray(error.response.message)
      ) {
        const validationErrors = error.response.message;
        this.logger.error("Validation errors:", validationErrors);
      }

      throw error;
    }
  }

  @Get()
  @ApiOperation({
    summary: "Get all professionals with pagination and filtering",
  })
  @ApiResponse({ status: 200, description: "List of professionals" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async findAll(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
    @Query("status") status?: string,
  ) {
    const pageNum = parseInt(page || "1", 10) || 1;
    const limitNum = parseInt(limit || "10", 10) || 10;
    return this.adminProfessionalsService.findAll({
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
  async findOne(@Param("id") id: string) {
    return this.adminProfessionalsService.findOne(id);
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
    @Param("id") id: string,
    @Body() updateProfessionalDto: UpdateProfessionalDto,
  ) {
    return this.adminProfessionalsService.update(id, updateProfessionalDto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete professional by ID" })
  @ApiResponse({
    status: 200,
    description: "Professional deleted successfully",
  })
  @ApiResponse({ status: 404, description: "Professional not found" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async remove(@Param("id") id: string) {
    return this.adminProfessionalsService.remove(id);
  }

  @Get("search/:query")
  @ApiOperation({ summary: "Search professionals by name, email, or phone" })
  @ApiResponse({ status: 200, description: "Search results" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async search(@Param("query") query: string) {
    return this.adminProfessionalsService.search(query);
  }

  @Get(":id/availability")
  @ApiOperation({ summary: "Get professional availability" })
  @ApiResponse({ status: 200, description: "Professional availability data" })
  @ApiResponse({ status: 404, description: "Professional not found" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async getAvailability(@Param("id") id: string) {
    return this.adminProfessionalsService.getAvailability(id);
  }

  @Patch(":id/password")
  @ApiOperation({ summary: "Change professional password" })
  @ApiResponse({ status: 200, description: "Password changed successfully" })
  @ApiResponse({ status: 404, description: "Professional not found" })
  @ApiResponse({ status: 400, description: "Invalid input data" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async changePassword(
    @Param("id") id: string,
    @Body() changePasswordDto: ChangeProfessionalPasswordDto,
  ) {
    return this.adminProfessionalsService.changePassword(id, changePasswordDto);
  }
}
