import { ParseUUIDPipe, Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Req, ForbiddenException } from "@nestjs/common";
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
import { ClientsService, ClientFilters } from "./clients.service";
import { CreateClientDto, UpdateClientDto } from "./dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "@prisma/client";
import { ProfessionalsService } from "../professionals/professionals.service";

@ApiTags("clients")
@Controller("clients")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ClientsController {
  constructor(
    private readonly clientsService: ClientsService,
    private readonly professionalsService: ProfessionalsService,
  ) {}

  @Post()
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Create a new client" })
  @ApiResponse({ status: 201, description: "Client created successfully" })
  async create(@Body() createClientDto: CreateClientDto) {
    return this.clientsService.create(createClientDto);
  }

  @Get()
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get all clients with optional filters" })
  async findAll(@Req() req: any, @Query("tenantId") tenantId?: string) {
    // Para Staff, filtrar solo clientes con los que tienen citas
    let professionalId = null;
    if (req.user.role === "staff") {
      const professional =
        await this.professionalsService.getProfessionalByUserId(
          req.user.id,
          req.user.tenantId,
        );
      professionalId = professional?.id;
    }

    return this.clientsService.findAll(tenantId, professionalId);
  }

  @Get("filter")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Get clients with filters for email campaigns" })
  async findWithFilters(
    @CurrentUser() user: User,
    @Query("gender") gender?: string,
    @Query("minAge") minAge?: string,
    @Query("maxAge") maxAge?: string,
    @Query("tags") tags?: string,
    @Query("loyaltyTier") loyaltyTier?: string,
    @Query("status") status?: string,
    @Query("minTotalSpent") minTotalSpent?: string,
    @Query("maxTotalSpent") maxTotalSpent?: string,
    @Query("minVisits") minVisits?: string,
    @Query("maxVisits") maxVisits?: string,
  ) {
    const filters: ClientFilters = {
      gender: gender as any,
      minAge: minAge ? parseInt(minAge) : undefined,
      maxAge: maxAge ? parseInt(maxAge) : undefined,
      tags: tags ? tags.split(",") : undefined,
      loyaltyTier: loyaltyTier as any,
      status: status as any,
      minTotalSpent: minTotalSpent ? parseFloat(minTotalSpent) : undefined,
      maxTotalSpent: maxTotalSpent ? parseFloat(maxTotalSpent) : undefined,
      minVisits: minVisits ? parseInt(minVisits) : undefined,
      maxVisits: maxVisits ? parseInt(maxVisits) : undefined,
      hasEmail: true,
    };
    return this.clientsService.findAllWithFilters(user.tenantId, filters);
  }

  @Get(":id")
  // Was @Public(): an unauthenticated GET that returned any client by
  // UUID, taxId included, with no tenant check. No frontend caller used
  // it. Now authenticated, tenant-scoped, and a client may only read
  // their own record.
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff, UserRole.client)
  @ApiOperation({ summary: "Get client by ID" })
  @ApiResponse({ status: 200, description: "Client found" })
  @ApiResponse({ status: 404, description: "Client not found" })
  async findOne(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    if (user.role === UserRole.client && user.id !== id) {
      throw new ForbiddenException("A client may only read their own record");
    }
    return this.clientsService.findOne(user.tenantId, id);
  }

  @Put(":id")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Update a client" })
  @ApiResponse({ status: 200, description: "Client updated successfully" })
  @ApiResponse({ status: 404, description: "Client not found" })
  async update(
    @CurrentUser() user: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateClientDto: UpdateClientDto,
  ) {
    return this.clientsService.update(user.tenantId, id, updateClientDto);
  }

  @Delete(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Delete a client" })
  @ApiResponse({ status: 200, description: "Client deleted successfully" })
  @ApiResponse({ status: 404, description: "Client not found" })
  async remove(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.clientsService.remove(user.tenantId, id);
  }
}
