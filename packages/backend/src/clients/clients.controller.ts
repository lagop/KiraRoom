import { ParseUUIDPipe, Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, UseGuards, ForbiddenException, NotFoundException, HttpCode, HttpStatus } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";
import { ClientsService, ClientFilters, ClientScope } from "./clients.service";
import { CreateClientDto, UpdateClientDto, UpdateMyProfileDto, ChangeMyPasswordDto } from "./dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "@prisma/client";
import { ProfessionalsService } from "../professionals/professionals.service";
import { AllowWhenReadOnly } from "../common/decorators/allow-when-read-only.decorator";

/**
 * Who reaches which client here:
 *
 * - owner / admin: every client of their salon.
 * - staff: only clients with at least one appointment (any status) with
 *   their own professional record. The list shows only those; GET and PUT
 *   on any other id answer 404. A staff user with no professional record
 *   reaches no client at all (empty list, 404). Staff may edit those
 *   clients' details but not their email or status (403), and every
 *   client they create starts active.
 * - client: only their own record (GET /clients/:id, /clients/me).
 */
@ApiTags("clients")
@Controller("clients")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ClientsController {
  constructor(
    private readonly clientsService: ClientsService,
    private readonly professionalsService: ProfessionalsService,
  ) {}

  /**
   * {} for owner/admin, the professional for staff, null for a staff user
   * with no professional record (fail closed: no client).
   */
  private async scopeFor(user: any): Promise<ClientScope | null> {
    if (user.role !== UserRole.staff) return {};
    const professional = await this.professionalsService.getProfessionalByUserId(
      user.id,
      user.tenantId,
    );
    return professional ? { professionalId: professional.id } : null;
  }

  private async scopeOrNotFound(user: any): Promise<ClientScope> {
    const scope = await this.scopeFor(user);
    if (!scope) throw new NotFoundException("Cliente no encontrado");
    return scope;
  }

  @Post()
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Create a new client" })
  @ApiResponse({ status: 201, description: "Client created successfully" })
  @ApiResponse({ status: 409, description: "The email is already used by another client of the salon" })
  async create(@CurrentUser() user: any, @Body() createClientDto: CreateClientDto) {
    // The tenant comes from the caller's token, never from the body: the
    // dashboard fell back to 'default-tenant' when localStorage had no user.
    // Staff do not choose the status: a new client starts active.
    const dto =
      user.role === UserRole.staff ? { ...createClientDto, status: undefined } : createClientDto;
    return this.clientsService.create(user.tenantId, dto);
  }

  @Get()
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "The salon's clients (staff: only their own)" })
  // A `tenantId` query parameter is ignored: the tenant is the caller's.
  async findAll(@CurrentUser() user: any) {
    const scope = await this.scopeFor(user);
    if (!scope) return [];
    return this.clientsService.findAll(user.tenantId, scope);
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

  // Before ":id", which would capture it (see route-order.spec).
  @Get("me")
  @Roles(UserRole.client)
  @ApiOperation({ summary: "A client reads their own profile" })
  async getMe(@CurrentUser() user: any) {
    return this.clientsService.getSelf(user.tenantId, user.id);
  }

  @Get(":id")
  // Was @Public(): an unauthenticated GET that returned any client by
  // UUID, taxId included, with no tenant check. Now authenticated and
  // tenant-scoped; a client may only read their own record and staff only
  // their own clients (see the class comment).
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff, UserRole.client)
  @ApiOperation({ summary: "A client's file: details and visits" })
  @ApiResponse({ status: 200, description: "Client found" })
  @ApiResponse({ status: 404, description: "Client not found (or not one of the staff member's clients)" })
  async findOne(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    if (user.role === UserRole.client) {
      if (user.id !== id) {
        throw new ForbiddenException("A client may only read their own record");
      }
      return this.clientsService.findSelfRecord(user.tenantId, id);
    }
    const scope = await this.scopeOrNotFound(user);
    return this.clientsService.findOne(user.tenantId, id, scope);
  }

  @Patch("me")
  @Roles(UserRole.client)
  @ApiOperation({ summary: "A client updates their own profile" })
  async updateMe(@CurrentUser() user: any, @Body() dto: UpdateMyProfileDto) {
    return this.clientsService.updateSelf(user.tenantId, user.id, dto);
  }

  @Post("me/password")
  @Roles(UserRole.client)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "A client changes their own password" })
  async changeMyPassword(@CurrentUser() user: any, @Body() dto: ChangeMyPasswordDto) {
    await this.clientsService.changeOwnPassword(user.tenantId, user.id, dto);
  }

  @Put(":id")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Update a client (staff: their own clients, not email or status)" })
  @ApiResponse({ status: 200, description: "Client updated successfully" })
  @ApiResponse({ status: 403, description: "Staff changing the email or the status" })
  @ApiResponse({ status: 404, description: "Client not found (or not one of the staff member's clients)" })
  @ApiResponse({ status: 409, description: "The email is already used by another client of the salon" })
  async update(
    @CurrentUser() user: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateClientDto: UpdateClientDto,
  ) {
    const scope = await this.scopeOrNotFound(user);
    return this.clientsService.update(user.tenantId, id, updateClientDto, scope);
  }

  @Delete(":id")
  @AllowWhenReadOnly()
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Delete a client" })
  @ApiResponse({ status: 200, description: "Client deleted successfully" })
  @ApiResponse({ status: 404, description: "Client not found" })
  async remove(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.clientsService.remove(user.tenantId, id);
  }
}
