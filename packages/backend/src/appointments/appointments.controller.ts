import { ParseUUIDPipe, Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, UseGuards, UseInterceptors, Req, Logger } from "@nestjs/common";
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
  AppointmentFiltersDto,
} from "./appointments.service";
// The class, not the service's same-named interface: the ValidationPipe
// only validates (and strips unknown keys from) a class.
import { UpdateAppointmentDto } from "./dto/update-appointment.dto";
import { UpdateAppointmentPaymentDto } from "./dto/update-appointment-payment.dto";
import { CancelAppointmentDto, CompleteAppointmentDto } from "./dto/appointment-status.dto";
import { AvailableSlotsDto } from "./dto/available-slots.dto";
import { HomeSummaryService } from "./home-summary.service";
import { OnlineBookingDto, StaffBookingDto, isHoneypotHit } from "./dto/book-appointment.dto";
import { randomUUID } from "crypto";
import { PublicViewerService } from "../common/tenancy/public-viewer.service";
import { ScrubSecretsInterceptor, publicBooking } from "./appointment-response";
import { Public } from "../auth/decorators/public.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";
import { Throttle } from "@nestjs/throttler";
import { clientIp } from "../common/client-ip";

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
// No response from here carries secrets: see appointment-response.ts.
@UseInterceptors(ScrubSecretsInterceptor)
@ApiBearerAuth()
export class AppointmentsController {
  private readonly logger = new Logger(AppointmentsController.name);

  constructor(
    private readonly appointmentsService: AppointmentsService,
    private readonly publicViewer: PublicViewerService,
    private readonly homeSummary: HomeSummaryService,
  ) {}

  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 5 } }) // public booking: a person books once
  @Public()
  @ApiOperation({ summary: "Create a new appointment (public)" })
  @ApiResponse({ status: 201, description: "Appointment created successfully" })
  async create(@Body() dto: OnlineBookingDto, @Req() req: any) {
    // The booker's IP, hashed into the record of what she ticked (promotions,
    // WhatsApp notices), as the consent routes do.
    // From the trusted proxy, as the rate limiter counts it (clientIp).
    const ip = clientIp(req);
    // The hidden field a person never sees was filled in: a bot. Nothing is
    // booked or sent; it gets an answer shaped like a pending booking, so it
    // learns nothing. Logged without its data.
    if (isHoneypotHit(dto)) {
      this.logger.warn(
        `Public booking dropped: hidden field filled (service ${dto.serviceId}, professional ${dto.professionalId || "any"})`,
      );
      return {
        id: randomUUID(),
        status: "pending",
        scheduledDate: dto.scheduledDate,
        scheduledTime: dto.scheduledTime,
        service: null,
        professional: null,
        location: null,
      };
    }
    // Public: whoever booked gets the booking back, not the client record it
    // attached to nor the salon's row.
    return publicBooking(await this.appointmentsService.createOnline(dto, { ip }));
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
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
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
      locationId,
      widgetInstanceId,
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
      { onlineWindow: !staff, locationId, widgetInstanceId },
    );
  }

  /**
   * Until which day a client may book a service online (its
   * maxAdvanceBooking, in the salon's calendar), so the booking page and the
   * widget can stop the date picker there and say why a later day has no
   * times, instead of "no free times this day".
   */
  @Get("booking-window")
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Public()
  @ApiOperation({ summary: "Last day a service can be booked online (public)" })
  @ApiQuery({ name: "tenantId", required: true })
  @ApiQuery({ name: "serviceId", required: true })
  async bookingWindow(
    @Query("tenantId", ParseUUIDPipe) tenantId: string,
    @Query("serviceId", ParseUUIDPipe) serviceId: string,
  ) {
    return this.appointmentsService.publicBookingWindow(tenantId, serviceId);
  }

  /**
   * Inicio's lists (home-summary.service.ts): today's appointments, the
   * pending ones from today on and the visits still owed, five rows each
   * with the true totals, in the salon's day. Staff: their own. Owner and
   * admins may ask for one location (Empresa), as in Analítica.
   */
  @Get("home")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "The panel's home lists: today, to confirm and to charge" })
  @ApiQuery({ name: "locationId", required: false, type: String })
  async home(@Req() req: any, @Query("locationId") locationId?: string) {
    return this.homeSummary.getHome(req.user, { locationId });
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

  /**
   * The salon's locations for the panel's booking forms and the agenda's
   * filter (multi-local): two or more with someone to book, and where each
   * professional works. Empty for every other salon, which then sees no
   * location picker at all.
   */
  @Get("booking-locations")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Locations to book at and where each professional works (multi-location)" })
  async bookingLocations(@Req() req: any) {
    return this.appointmentsService.bookingLocations(req.user.tenantId);
  }

  @Get(":id")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get appointment by ID" })
  @ApiResponse({ status: 200, description: "Appointment found" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async findOne(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    // Staff: also a colleague's visit where they do a service, read only.
    return this.appointmentsService.findOne(req.user, id, "read");
  }

  // A professional edits or moves their own appointments (the service checks
  // the appointment is theirs and keeps it on their agenda).
  @Patch(":id")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
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
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff) // staff: their own, via findOne
  @ApiOperation({ summary: "Cancel an appointment" })
  @ApiResponse({
    status: 200,
    description: "Appointment cancelled successfully",
  })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async cancel(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CancelAppointmentDto,
  ) {
    return this.appointmentsService.cancel(req.user, id, body?.reason);
  }

  // The actions on an appointment that time off or a closure caught
  // (Solicitudes de ausencia): whoever runs the salon decides each one.
  @Get(":id/free-professionals")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Professionals free to take the appointment at its day and time" })
  async freeProfessionals(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.appointmentsService.freeProfessionalsFor(req.user, id);
  }

  @Put(":id/cancel-for-time-off")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Cancel an appointment caught by time off and tell the client, with a link to book again" })
  async cancelForTimeOff(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CancelAppointmentDto,
  ) {
    return this.appointmentsService.cancelForTimeOff(req.user, id, body?.reason);
  }

  @Put(":id/complete")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff) // staff: their own, via findOne
  @ApiOperation({ summary: "Mark appointment as completed" })
  @ApiResponse({ status: 200, description: "Appointment marked as completed" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  async complete(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CompleteAppointmentDto,
  ) {
    return this.appointmentsService.complete(req.user, id, body?.notes);
  }

  @Put(":id/no-show")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff) // staff: their own, via findOne
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

  // Owner and managers only: a manual correction. A professional marked
  // their own appointments paid for any amount here, and the client earned
  // points on it; the till charges appointments itself now (POST
  // /pos/checkout), staff included.
  @Patch(":id/payment")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Correct an appointment's payment status (owner/admin)" })
  @ApiResponse({ status: 200, description: "Payment status updated successfully" })
  @ApiResponse({ status: 400, description: "Amount above the appointment's total" })
  @ApiResponse({ status: 404, description: "Appointment not found" })
  @ApiResponse({ status: 409, description: "Cancelled or no-show appointment marked paid" })
  async updatePayment(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateAppointmentPaymentDto,
  ) {
    return this.appointmentsService.updatePaymentStatus(
      req.user,
      id,
      body,
    );
  }
}
