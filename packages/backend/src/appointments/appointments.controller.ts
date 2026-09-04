import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import {
  AppointmentsService,
  CreateAppointmentDto,
  UpdateAppointmentDto,
  AppointmentFiltersDto,
} from "./appointments.service";
import { AvailableSlotsDto } from "./dto/available-slots.dto";
import { Public } from "../auth/decorators/public.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    tenantId: string;
    role: UserRole;
    professionalId?: string;
  };
}

@ApiTags("appointments")
@Controller("appointments")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  @Post()
  @Public()
  @ApiOperation({ summary: "Create a new appointment (public)" })
  @ApiResponse({ status: 201, description: "Appointment created successfully" })
  async create(@Body() createAppointmentDto: CreateAppointmentDto) {
    return this.appointmentsService.create(createAppointmentDto);
  }

  @Post("staff")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Create a new appointment (staff authenticated)" })
  @ApiResponse({ status: 201, description: "Appointment created successfully" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - insufficient permissions",
  })
  async createByStaff(
    @Body() createAppointmentDto: CreateAppointmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.appointmentsService.createByStaff(
      createAppointmentDto,
      req.user,
    );
  }

  @Get()
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get all appointments with optional filters" })
  async findAll(@Req() req: any, @Query() filters: AppointmentFiltersDto) {
    return this.appointmentsService.findAll(req.user, filters);
  }

  // IMPORTANT: Specific routes must come BEFORE parameterized routes
  @Get("available-slots")
  @Public()
  @ApiOperation({ summary: "Get available slots for appointments" })
  @ApiResponse({
    status: 200,
    description: "Available slots retrieved successfully",
  })
  async getAvailableSlots(@Query() query: AvailableSlotsDto) {
    const {
      tenantId,
      date,
      professionalId,
      professionalIds,
      serviceId,
      duration,
    } = query;
    // Parse professionalIds if provided as comma-separated string
    const profIds = professionalIds
      ? professionalIds.split(",").filter(Boolean)
      : undefined;
    return this.appointmentsService.getAvailableSlots(
      tenantId,
      new Date(date),
      professionalId,
      serviceId,
      duration,
      profIds,
    );
  }

  @Get(":id")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get appointment by ID" })
  @ApiResponse({ status: 200, description: "Appointment found" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async findOne(@Req() req: any, @Param("id") id: string) {
    return this.appointmentsService.findOne(req.user, id);
  }

  @Patch(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Update an appointment" })
  @ApiResponse({ status: 200, description: "Appointment updated successfully" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() updateAppointmentDto: UpdateAppointmentDto,
  ) {
    return this.appointmentsService.update(req.user, id, updateAppointmentDto);
  }

  @Put(":id/cancel")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Cancel an appointment" })
  @ApiResponse({
    status: 200,
    description: "Appointment cancelled successfully",
  })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async cancel(
    @Req() req: any,
    @Param("id") id: string,
    @Body("reason") reason?: string,
  ) {
    return this.appointmentsService.cancel(req.user, id, reason);
  }

  @Put(":id/complete")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Mark appointment as completed" })
  @ApiResponse({ status: 200, description: "Appointment marked as completed" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async complete(
    @Req() req: any,
    @Param("id") id: string,
    @Body("notes") notes?: string,
  ) {
    return this.appointmentsService.complete(req.user, id, notes);
  }

  @Put(":id/no-show")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Mark appointment as no-show" })
  @ApiResponse({ status: 200, description: "Appointment marked as no-show" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async markNoShow(@Req() req: any, @Param("id") id: string) {
    return this.appointmentsService.markNoShow(req.user, id);
  }

  @Get(":id/activity")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get appointment activity log" })
  @ApiResponse({
    status: 200,
    description: "Activity log retrieved successfully",
  })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async getAppointmentActivity(@Req() req: any, @Param("id") id: string) {
    return this.appointmentsService.getAppointmentActivity(req.user, id);
  }

  @Delete(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Delete an appointment" })
  @ApiResponse({ status: 200, description: "Appointment deleted successfully" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async remove(@Req() req: any, @Param("id") id: string) {
    return this.appointmentsService.remove(req.user, id);
  }

  @Get("pending-payment")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get appointments pending payment" })
  @ApiQuery({ name: "searchQuery", required: false })
  @ApiQuery({ name: "dateFrom", required: false })
  @ApiQuery({ name: "dateTo", required: false })
  @ApiQuery({ name: "status", required: false })
  async findPendingPayment(
    @Req() req: any,
    @Query() query: any,
  ) {
    const { searchQuery, dateFrom, dateTo, status } = query;
    return this.appointmentsService.findPendingPayment(
      req.user,
      { searchQuery, dateFrom, dateTo, status },
    );
  }

  @Patch(":id/payment")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Update appointment payment status" })
  @ApiResponse({ status: 200, description: "Payment status updated successfully" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async updatePayment(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: { status: string; amountPaid: number; paymentMethod: string },
  ) {
    return this.appointmentsService.updatePaymentStatus(
      req.user,
      id,
      body,
    );
  }
}
