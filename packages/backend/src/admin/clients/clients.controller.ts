import { ParseUUIDPipe, Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AdminClientsService } from './clients.service';
import { ClientMergeService } from './client-merge.service';
import { CreateClientDto, MergeClientDto, UpdateClientDto } from './dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AllowWhenReadOnly } from "../../common/decorators/allow-when-read-only.decorator";

@ApiTags('Admin - Clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.owner, UserRole.admin)
@Controller('admin/clients')
export class AdminClientsController {
  constructor(
    private readonly adminClientsService: AdminClientsService,
    private readonly clientMerge: ClientMergeService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new client' })
  @ApiResponse({ status: 201, description: 'Client created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async create(@CurrentUser() user: any, @Body() createClientDto: CreateClientDto) {
    // The tenant comes from the caller's token, never from the body.
    return this.adminClientsService.create(user.tenantId, createClientDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all clients with pagination and filtering' })
  @ApiResponse({ status: 200, description: 'List of clients' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findAll(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    const pageNum = parseInt(page || '1', 10) || 1;
    const limitNum = parseInt(limit || '10', 10) || 10;
    return this.adminClientsService.findAll({
      tenantId: user.tenantId,
      page: pageNum,
      limit: limitNum,
      search: search || '',
      status,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get client by ID' })
  @ApiResponse({ status: 200, description: 'Client details' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.adminClientsService.findOne(user.tenantId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update client by ID' })
  @ApiResponse({ status: 200, description: 'Client updated successfully' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async update(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateClientDto: UpdateClientDto,
  ) {
    return this.adminClientsService.update(user.tenantId, id, updateClientDto);
  }

  @Delete(':id')
  @AllowWhenReadOnly()
  @ApiOperation({ summary: 'Delete client by ID' })
  @ApiResponse({ status: 200, description: 'Client deleted successfully' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async remove(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.adminClientsService.remove(user.tenantId, id);
  }

  @Post(':id/merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge a duplicate client into this one',
    description:
      'Everything the source record has (appointments, payments, sales, invoices, wallet, loyalty, consents, ...) moves to :id in one transaction; empty fields of :id are filled from the source; the source is then deleted. See client-merge.service.ts.',
  })
  @ApiResponse({ status: 200, description: 'Merged; `message` says what moved' })
  @ApiResponse({ status: 400, description: 'The same record twice' })
  @ApiResponse({ status: 404, description: 'Either record is not a client of this salon' })
  @ApiResponse({ status: 409, description: 'Into a deactivated record, or a blocked record into one that is not' })
  async merge(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeClientDto,
  ) {
    return this.clientMerge.merge(user.tenantId, id, dto.sourceClientId, { id: user.id, role: user.role });
  }

  @Get('search/:query')
  @ApiOperation({ summary: 'Search clients by name, email, or phone' })
  @ApiResponse({ status: 200, description: 'Search results' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async search(@CurrentUser() user: any, @Param('query') query: string) {
    return this.adminClientsService.search(user.tenantId, query);
  }
}