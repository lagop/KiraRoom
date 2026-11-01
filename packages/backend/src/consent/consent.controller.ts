import { ParseUUIDPipe, Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, Req, UseGuards, BadRequestException } from "@nestjs/common";
import { IsBoolean, IsOptional } from "class-validator";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ConsentService } from "./consent.service";
import { CreateConsentFormDto, RevokeConsentDto, SignConsentDto, UpdateConsentFormDto } from "./consent.dto";
import { Roles, SALON_TEAM, SALON_MANAGERS } from "../auth/decorators/roles.decorator";

/** A choice about email promotions (the salon only records a refusal). */
export class MarketingChoiceDto {
  @IsBoolean()
  accepts!: boolean;
}

/**
 * The salon records a client's WhatsApp choice made in person. Saying yes
 * needs the staff member to confirm the client agreed: Meta only allows
 * marketing to people who opted in, and the record says the salon wrote it.
 */
export class SalonWhatsAppChoiceDto {
  @IsBoolean()
  accepts!: boolean;

  @IsOptional()
  @IsBoolean()
  confirmedInPerson?: boolean;
}

/**
 * The channels of a client's appointment notices, set from her file. Only
 * the channels sent change. Turning WhatsApp on needs `clientAsked`: the
 * team member confirms the client asked for it, and the record says who.
 */
export class ClientNoticesDto {
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  sms?: boolean;

  @IsOptional()
  @IsBoolean()
  whatsapp?: boolean;

  @IsOptional()
  @IsBoolean()
  clientAsked?: boolean;
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
  create(@Req() req: AuthedRequest, @Body() body: CreateConsentFormDto) {
    return this.service.createForm(req.user.tenantId, body);
  }

  @Patch(":id")
  @Roles(...SALON_MANAGERS)
  update(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateConsentFormDto,
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

  /**
   * Records a signed consent taken in the salon. It used to be public and
   * take the salon and the client from the body; a signature now needs a
   * team member's session, and the salon is the session's. The team member
   * names the client and types the name she signed with; the record keeps
   * who recorded it. (Clients have no accounts, so none signs for herself.)
   */
  @Post("sign")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(...SALON_TEAM)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async sign(@Body() body: SignConsentDto, @Req() req: AuthedRequest) {
    if (!body.clientId) throw new BadRequestException("Indica la clienta que firma");
    if (!body.signatureName?.trim()) {
      throw new BadRequestException("Escribe el nombre con el que firma la clienta");
    }
    return this.service.sign({
      tenantId: req.user.tenantId,
      formId: body.formId,
      responses: body.responses ?? {},
      ip: clientIp(req),
      appointmentId: body.appointmentId,
      serviceId: body.serviceId,
      clientId: body.clientId,
      signatureName: body.signatureName,
      recordedBy: req.user.id,
    });
  }

  /** Both choices of a client, for the client file in the panel. */
  @Get("clients/:clientId/marketing")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(...SALON_TEAM)
  async clientMarketing(@Req() req: AuthedRequest, @Param("clientId", ParseUUIDPipe) clientId: string) {
    await this.service.assertClientInReach(req.user.tenantId, clientId, req.user);
    const [email, whatsapp] = await Promise.all([
      this.service.getMarketingConsent(req.user.tenantId, clientId, "email"),
      this.service.getMarketingConsent(req.user.tenantId, clientId, "whatsapp"),
    ]);
    return { email, whatsapp };
  }

  /** The salon records the WhatsApp choice a client made in person. */
  @Put("clients/:clientId/whatsapp-marketing")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(...SALON_TEAM)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async setClientWhatsAppMarketing(
    @Req() req: AuthedRequest,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Body() dto: SalonWhatsAppChoiceDto,
  ) {
    if (dto.accepts && dto.confirmedInPerson !== true) {
      throw new BadRequestException("Confirma que el cliente ha aceptado recibir promociones por WhatsApp");
    }
    await this.service.assertClientInReach(req.user.tenantId, clientId, req.user);
    return this.service.recordMarketingChoice({
      tenantId: req.user.tenantId,
      clientId,
      accepts: dto.accepts,
      ip: clientIp(req),
      channel: "whatsapp",
      recordedBy: req.user.id,
    });
  }

  /**
   * The salon writes down that the client does not want promotions by
   * email (she said so in person, by phone, by replying to an email). Only
   * a refusal: withdrawing is always allowed, but an acceptance of email
   * promotions is the client's own to give, never the salon's to record.
   */
  @Put("clients/:clientId/marketing")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(...SALON_TEAM)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async setClientEmailMarketing(
    @Req() req: AuthedRequest,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Body() dto: MarketingChoiceDto,
  ) {
    if (dto.accepts !== false) {
      throw new BadRequestException(
        "El salón solo puede anotar que la clienta no quiere promociones por email",
      );
    }
    await this.service.assertClientInReach(req.user.tenantId, clientId, req.user);
    return this.service.recordMarketingChoice({
      tenantId: req.user.tenantId,
      clientId,
      accepts: false,
      ip: clientIp(req),
      channel: "email",
      recordedBy: req.user.id,
    });
  }

  /** How the client gets her appointment notices (email, SMS, WhatsApp). */
  @Get("clients/:clientId/notices")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(...SALON_TEAM)
  async clientNotices(@Req() req: AuthedRequest, @Param("clientId", ParseUUIDPipe) clientId: string) {
    await this.service.assertClientInReach(req.user.tenantId, clientId, req.user);
    return this.service.getClientNotices(req.user.tenantId, clientId);
  }

  /**
   * The salon sets the channels of the client's appointment notices: clients
   * have no account to do it themselves. WhatsApp on is her request, written
   * down with who recorded it (see ConsentService.setClientNotices).
   */
  @Put("clients/:clientId/notices")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(...SALON_TEAM)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async setClientNotices(
    @Req() req: AuthedRequest,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Body() dto: ClientNoticesDto,
  ) {
    await this.service.assertClientInReach(req.user.tenantId, clientId, req.user);
    const { clientAsked, ...changes } = dto;
    return this.service.setClientNotices({
      tenantId: req.user.tenantId,
      clientId,
      changes,
      ip: clientIp(req),
      recordedBy: req.user.id,
      clientAsked,
    });
  }

  @Post(":id/revoke")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(...SALON_MANAGERS)
  revoke(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RevokeConsentDto,
  ) {
    return this.service.revoke(req.user.tenantId, id, body?.reason);
  }
}

function clientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    ""
  );
}
