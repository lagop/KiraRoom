import { ParseUUIDPipe, Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, UseGuards, BadRequestException } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Public } from "../auth/decorators/public.decorator";
import { ConsentService } from "./consent.service";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

@ApiTags("consent-forms")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("consent-forms")
export class ConsentFormsController {
  constructor(private readonly service: ConsentService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.service.listForms(req.user.tenantId);
  }

  @Post()
  create(@Req() req: AuthedRequest, @Body() body: any) {
    return this.service.createForm(req.user.tenantId, body);
  }

  @Patch(":id")
  update(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: any,
  ) {
    return this.service.updateForm(req.user.tenantId, id, body);
  }

  @Delete(":id")
  remove(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.deleteForm(req.user.tenantId, id);
  }
}

@ApiTags("consent")
@Controller("consent")
export class ConsentController {
  constructor(private readonly service: ConsentService) {}

  @Get("required")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  required(
    @Req() req: AuthedRequest,
    @Query("serviceId") serviceId?: string,
    @Query("clientId") clientId?: string,
  ) {
    return this.service.getRequiredForms(req.user.tenantId, serviceId);
  }

  @Post("sign")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async sign(@Body() body: any, @Req() req: Request) {
    if (!body?.tenantId || !body?.clientId || !body?.formId) {
      throw new BadRequestException("tenantId, clientId and formId required");
    }
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";
    return this.service.sign({
      tenantId: body.tenantId,
      clientId: body.clientId,
      formId: body.formId,
      responses: body.responses ?? {},
      signatureName: body.signatureName,
      ip,
      appointmentId: body.appointmentId,
      serviceId: body.serviceId,
    });
  }

  @Post(":id/revoke")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  revoke(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
  ) {
    return this.service.revoke(req.user.tenantId, id, body?.reason);
  }
}