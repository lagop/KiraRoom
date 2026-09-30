import { ParseUUIDPipe, Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, UseGuards, Req } from "@nestjs/common";
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
import { OnlineBookingDto, StaffBookingDto } from "./dto/book-appointment.dto";
import { PublicViewerService } from "../common/tenancy/public-viewer.service";
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
  constructor(
    private readonly appointmentsService: AppointmentsService,
    private readonly publicViewer: PublicViewerService,
  ) {}

  @Post()
  @Public()
  @ApiOperation({ summary: "Create a new appointment (public)" })
  @ApiResponse({ status: 201, description: "Appointment created successfully" })
  async create(@Body() dto: OnlineBookingDto) {
    return this.appointmentsService.createOnline(dto);
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
    @Body() createAppointmentDto: StaffBookingDto,
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
  async getAvailableSlots(@Req() req: any, @Query() query: AvailableSlotsDto) {
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
    // The salon's own staff may book at short notice by hand; everyone else
    // is offered only what an online booking will accept.
    const { staff } = await this.publicViewer.resolve(req, tenantId);
    return this.appointmentsService.getAvailableSlots(
      tenantId,
      new Date(date),
      professionalId,
      serviceId,
      duration,
      profIds,
      { onlineWindow: !staff },
    );
  }

  // Literal paths must be declared before ":id". Declared after it,
  // "pending-payment" matched ":id" first and ParseUUIDPipe answered 400, so
  // the dashboard's pending-payments list never loaded.
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

  @Get("mine")
  @Roles(UserRole.client)
  @ApiOperation({ summary: "The calling client's own appointments" })
  async findMine(@Req() req: any) {
    return this.appointmentsService.findForClient(req.user);
  }

  @Get(":id")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get appointment by ID" })
  @ApiResponse({ status: 200, description: "Appointment found" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async findOne(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.appointmentsService.findOne(req.user, id);
  }

  @Patch(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Update an appointment" })
  @ApiResponse({ status: 200, description: "Appointment updated successfully" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async update(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateAppointmentDto: UpdateAppointmentDto,
  ) {
    return this.appointmentsService.update(req.user, id, updateAppointmentDto);
  }

  @Put(":id/cancel")
  // A client may cancel their own appointment, with the salon's notice.
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff, UserRole.client)
  @ApiOperation({ summary: "Cancel an appointment" })
  @ApiResponse({
    status: 200,
    description: "Appointment cancelled successfully",
  })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async cancel(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
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
    @Param("id", ParseUUIDPipe) id: string,
    @Body("notes") notes?: string,
  ) {
    return this.appointmentsService.complete(req.user, id, notes);
  }

  @Put(":id/no-show")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Mark appointment as no-show" })
  @ApiResponse({ status: 200, description: "Appointment marked as no-show" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async markNoShow(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
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
  async getAppointmentActivity(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.appointmentsService.getAppointmentActivity(req.user, id);
  }

  @Delete(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Delete an appointment" })
  @ApiResponse({ status: 200, description: "Appointment deleted successfully" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async remove(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.appointmentsService.remove(req.user, id);
  }

  @Patch(":id/payment")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Update appointment payment status" })
  @ApiResponse({ status: 200, description: "Payment status updated successfully" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async updatePayment(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { status: string; amountPaid: number; paymentMethod: string },
  ) {
    return this.appointmentsService.updatePaymentStatus(
      req.user,
      id,
      body,
    );
  }
}
