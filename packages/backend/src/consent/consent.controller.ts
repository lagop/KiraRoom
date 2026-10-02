import { ParseUUIDPipe, Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, Req, UseGuards, BadRequestException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { IsBoolean } from "class-validator";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Public } from "../auth/decorators/public.decorator";
import { ConsentService } from "./consent.service";
import { Roles, SALON_TEAM, SALON_MANAGERS } from "../auth/decorators/roles.decorator";

/** A client's choice about commercial communications. */
export class MarketingChoiceDto {
  @IsBoolean()
  accepts!: boolean;
}

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
  @Roles(...SALON_TEAM)
  list(@Req() req: AuthedRequest) {
    return this.service.listForms(req.user.tenantId);
  }

  @Post()
  @Roles(...SALON_MANAGERS)
  create(@Req() req: AuthedRequest, @Body() body: any) {
    return this.service.createForm(req.user.tenantId, body);
  }

  @Patch(":id")
  @Roles(...SALON_MANAGERS)
  update(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: any,
  ) {
    return this.service.updateForm(req.user.tenantId, id, body);
  }

  @Delete(":id")
  @Roles(...SALON_MANAGERS)
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
  @Roles(...SALON_TEAM)
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

  /** The signed-in client's choice about promotions and news by email. */
  @Get("me/marketing")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(UserRole.client)
  myMarketing(@Req() req: AuthedRequest) {
    return this.service.getMarketingConsent(req.user.tenantId, req.user.id);
  }

  /**
   * Records it as a signed Consent (see marketing-consent.ts). The account
   * page used to keep this checkbox in localStorage only.
   */
  @Put("me/marketing")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(UserRole.client)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  setMyMarketing(@Req() req: AuthedRequest, @Body() dto: MarketingChoiceDto) {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";
    return this.service.recordMarketingChoice({
      tenantId: req.user.tenantId,
      clientId: req.user.id,
      accepts: dto.accepts,
      ip,
    });
  }

  @Post(":id/revoke")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(...SALON_MANAGERS)
  revoke(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
  ) {
    return this.service.revoke(req.user.tenantId, id, body?.reason);
  }
}