import { ParseUUIDPipe, Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AdminClientsService } from './clients.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { UserRole } from '@prisma/client';

@ApiTags('Admin - Clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.owner, UserRole.admin)
@Controller('admin/clients')
export class AdminClientsController {
  constructor(private readonly adminClientsService: AdminClientsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new client' })
  @ApiResponse({ status: 201, description: 'Client created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async create(@Body() createClientDto: CreateClientDto) {
    return this.adminClientsService.create(createClientDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all clients with pagination and filtering' })
  @ApiResponse({ status: 200, description: 'List of clients' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    const pageNum = parseInt(page || '1', 10) || 1;
    const limitNum = parseInt(limit || '10', 10) || 10;
    return this.adminClientsService.findAll({ page: pageNum, limit: limitNum, search: search || '', status });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get client by ID' })
  @ApiResponse({ status: 200, description: 'Client details' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminClientsService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update client by ID' })
  @ApiResponse({ status: 200, description: 'Client updated successfully' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() updateClientDto: UpdateClientDto) {
    console.log('[Admin Clients] Update request - ID:', id, 'Data:', JSON.stringify(updateClientDto));
    return this.adminClientsService.update(id, updateClientDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete client by ID' })
  @ApiResponse({ status: 200, description: 'Client deleted successfully' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminClientsService.remove(id);
  }

  @Get('search/:query')
  @ApiOperation({ summary: 'Search clients by name, email, or phone' })
  @ApiResponse({ status: 200, description: 'Search results' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async search(@Param('query') query: string) {
    return this.adminClientsService.search(query);
  }
}