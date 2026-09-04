import { 
  Controller, 
  Get, 
  Post, 
  Put, 
  Delete, 
  Body, 
  Param, 
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AppointmentServicesService } from './appointment-services.service';
import { 
  CreateAppointmentServiceDto, 
  UpdateAppointmentServiceDto, 
  AppointmentServiceFiltersDto,
  AppointmentServiceStatus,
} from './dto/appointment-services.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Appointment Services')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('appointment-services')
export class AppointmentServicesController {
  constructor(private readonly appointmentServicesService: AppointmentServicesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new appointment service' })
  @ApiResponse({ status: 201, description: 'Appointment service created successfully' })
  @ApiResponse({ status: 404, description: 'Appointment or Service not found' })
  create(@Body() createDto: CreateAppointmentServiceDto) {
    return this.appointmentServicesService.create(createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all appointment services with optional filters' })
  @ApiResponse({ status: 200, description: 'List of appointment services' })
  findAll(@Query() filters: AppointmentServiceFiltersDto) {
    return this.appointmentServicesService.findAll(filters);
  }

  @Get('appointment/:appointmentId')
  @ApiOperation({ summary: 'Get all services for a specific appointment' })
  @ApiResponse({ status: 200, description: 'List of appointment services for the appointment' })
  findByAppointment(@Param('appointmentId', ParseUUIDPipe) appointmentId: string) {
    return this.appointmentServicesService.findByAppointment(appointmentId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific appointment service by ID' })
  @ApiResponse({ status: 200, description: 'Appointment service details' })
  @ApiResponse({ status: 404, description: 'Appointment service not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointmentServicesService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an appointment service' })
  @ApiResponse({ status: 200, description: 'Appointment service updated successfully' })
  @ApiResponse({ status: 404, description: 'Appointment service not found' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateAppointmentServiceDto,
  ) {
    return this.appointmentServicesService.update(id, updateDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an appointment service' })
  @ApiResponse({ status: 200, description: 'Appointment service deleted successfully' })
  @ApiResponse({ status: 404, description: 'Appointment service not found' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointmentServicesService.remove(id);
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Start an appointment service (mark as active)' })
  @ApiResponse({ status: 200, description: 'Service started' })
  @ApiResponse({ status: 404, description: 'Appointment service not found' })
  startService(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointmentServicesService.startService(id);
  }

  @Post(':id/complete')
  @ApiOperation({ summary: 'Complete an appointment service' })
  @ApiResponse({ status: 200, description: 'Service completed' })
  @ApiResponse({ status: 404, description: 'Appointment service not found' })
  completeService(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointmentServicesService.completeService(id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel an appointment service' })
  @ApiResponse({ status: 200, description: 'Service cancelled' })
  @ApiResponse({ status: 404, description: 'Appointment service not found' })
  cancelService(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointmentServicesService.cancelService(id);
  }

  @Post('bulk/:appointmentId')
  @ApiOperation({ summary: 'Create multiple appointment services for an appointment' })
  @ApiResponse({ status: 201, description: 'Appointment services created successfully' })
  @ApiResponse({ status: 404, description: 'Appointment not found' })
  bulkCreate(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() services: CreateAppointmentServiceDto[],
  ) {
    return this.appointmentServicesService.bulkCreate(appointmentId, services);
  }

  @Get('processing/:appointmentId')
  @ApiOperation({ summary: 'Get services with processing time for an appointment' })
  @ApiResponse({ status: 200, description: 'List of services with processing time' })
  getServicesWithProcessingTime(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
  ) {
    return this.appointmentServicesService.getServicesWithProcessingTime(appointmentId);
  }

  @Post(':id/processing-block')
  @ApiOperation({ summary: 'Create processing time block for a service' })
  @ApiResponse({ status: 201, description: 'Processing block created' })
  @ApiResponse({ status: 400, description: 'Service does not have processing time' })
  createProcessingBlock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('processingDuration') processingDuration?: number,
  ) {
    return this.appointmentServicesService.createProcessingBlocks(id, processingDuration);
  }

  @Put('appointment/:appointmentId/reorder')
  @ApiOperation({ summary: 'Reorder services for an appointment' })
  @ApiResponse({ status: 200, description: 'Services reordered successfully' })
  @ApiResponse({ status: 404, description: 'Appointment not found' })
  @ApiResponse({ status: 400, description: 'Invalid reorder request' })
  reorderServices(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() serviceOrders: Array<{ serviceId: string; order: number }>,
  ) {
    return this.appointmentServicesService.reorderServices(appointmentId, serviceOrders);
  }

  @Put(':id/timing')
  @ApiOperation({ summary: 'Update timing for a specific service' })
  @ApiResponse({ status: 200, description: 'Timing updated successfully' })
  @ApiResponse({ status: 404, description: 'Appointment service not found' })
  @ApiResponse({ status: 400, description: 'Invalid timing values' })
  updateTiming(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { scheduledStart: string; scheduledEnd: string },
  ) {
    return this.appointmentServicesService.updateTiming(
      id,
      new Date(body.scheduledStart),
      new Date(body.scheduledEnd),
    );
  }

  @Put(':id/mode')
  @ApiOperation({ summary: 'Toggle parallel/serial mode for a service' })
  @ApiResponse({ status: 200, description: 'Mode toggled successfully' })
  @ApiResponse({ status: 404, description: 'Appointment service not found' })
  toggleMode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { isParallel: boolean },
  ) {
    return this.appointmentServicesService.toggleMode(id, body.isParallel);
  }
}
