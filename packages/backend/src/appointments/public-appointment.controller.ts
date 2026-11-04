import { Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/decorators/public.decorator";
import { AppointmentsService } from "./appointments.service";

/**
 * "Cancelar mi cita": the link in the confirmation email and SMS of an
 * online booking (public-cancel-link.ts), so the client can cancel without
 * an account or a call, outside the salon's minCancelHours.
 *
 * Public: whoever has the notice has the link, and the link is signed. GET
 * only describes, so a mail scanner that follows links cancels nothing; the
 * page's button sends the POST. No rescheduling here.
 */
@ApiTags("Appointments (public)")
@Public()
@Controller("public/appointments")
export class PublicAppointmentController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get(":token")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "The appointment a cancel link is for, and whether it can still be cancelled online" })
  async describe(@Param("token") token: string) {
    const info = await this.appointments.describeCancelLink(token);
    if (!info) throw new NotFoundException("Enlace no válido");
    return info;
  }

  @Post(":token/cancel")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "The client cancels her appointment from the link" })
  async cancel(@Param("token") token: string) {
    const info = await this.appointments.cancelFromLink(token);
    if (!info) throw new NotFoundException("Enlace no válido");
    return info;
  }
}
