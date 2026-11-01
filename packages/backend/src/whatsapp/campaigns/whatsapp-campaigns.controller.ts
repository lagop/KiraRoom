import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";
import type { Request } from "express";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { Roles, SALON_MANAGERS } from "../../auth/decorators/roles.decorator";
import { FeatureGuard } from "../../common/guards/feature.guard";
import { Feature } from "../../common/decorators/feature.decorator";
import { MAX_BODY_LENGTH } from "./campaign-template";
import { WhatsAppCampaignsService } from "./whatsapp-campaigns.service";

export class CreateWhatsAppCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_BODY_LENGTH + 50)
  body!: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  inactiveDays?: number | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  scheduledAt?: string | null;
}

export class UpdateWhatsAppCampaignDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_BODY_LENGTH + 50)
  body?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  inactiveDays?: number | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  scheduledAt?: string | null;
}

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));

/**
 * What a salon whose plan does not include campaigns may still do: read its
 * past campaigns, and stop or delete one. Every plan has WhatsApp notices.
 */
const READ_OR_STOP = "whatsapp_notifications" as const;

/**
 * WhatsApp campaigns of the signed-in salon. Every route takes the salon
 * from the session: the old endpoints sent or reported any campaign by id.
 *
 * Campaigns are Pro and Empresa (whatsapp_marketing): creating, editing,
 * sending to Meta and resuming answer 403 FEATURE_NOT_IN_PLAN on Esencial,
 * and the page shows an upgrade notice. Reading the past campaigns, and
 * cancelling or deleting one, stay open to every plan (READ_OR_STOP).
 */
@ApiTags("whatsapp")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@Feature("whatsapp_marketing")
@Controller("whatsapp/campaigns")
export class WhatsAppCampaignsController {
  constructor(private readonly campaigns: WhatsAppCampaignsService) {}

  @Get()
  @Roles(...SALON_MANAGERS)
  @Feature(READ_OR_STOP)
  list(@Req() req: AuthedRequest) {
    return this.campaigns.list(req.user.tenantId);
  }

  @Get("audience")
  @Roles(...SALON_MANAGERS)
  audience(@Req() req: AuthedRequest, @Query("inactiveDays") inactiveDays?: string) {
    const days = Number(inactiveDays);
    return this.campaigns.audiencePreview(
      req.user.tenantId,
      Number.isInteger(days) && days > 0 ? Math.min(days, 3650) : null,
    );
  }

  /** Whether the plan includes campaigns: { included }. */
  @Get("access")
  @Roles(...SALON_MANAGERS)
  @Feature(READ_OR_STOP)
  access(@Req() req: AuthedRequest) {
    return this.campaigns.access(req.user.tenantId);
  }

  @Get(":id")
  @Roles(...SALON_MANAGERS)
  @Feature(READ_OR_STOP)
  get(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaigns.get(req.user.tenantId, id);
  }

  @Post()
  @Roles(...SALON_MANAGERS)
  create(@Req() req: AuthedRequest, @Body() dto: CreateWhatsAppCampaignDto) {
    return this.campaigns.create(req.user.tenantId, req.user.id, {
      name: dto.name,
      body: dto.body,
      inactiveDays: dto.inactiveDays ?? null,
      scheduledAt: toDate(dto.scheduledAt) ?? null,
    });
  }

  @Patch(":id")
  @Roles(...SALON_MANAGERS)
  update(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateWhatsAppCampaignDto) {
    return this.campaigns.update(req.user.tenantId, id, {
      name: dto.name,
      body: dto.body,
      inactiveDays: dto.inactiveDays,
      scheduledAt: toDate(dto.scheduledAt),
    });
  }

  /** Sends the text to Meta for review and schedules the campaign. */
  @Post(":id/submit")
  @Roles(...SALON_MANAGERS)
  submit(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaigns.submit(req.user.tenantId, id);
  }

  @Post(":id/cancel")
  @Roles(...SALON_MANAGERS)
  @Feature(READ_OR_STOP)
  cancel(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaigns.cancel(req.user.tenantId, id);
  }

  /** Carries on a campaign paused by an account-level Meta error, once the cause is fixed. */
  @Post(":id/resume")
  @Roles(...SALON_MANAGERS)
  resume(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaigns.resume(req.user.tenantId, id);
  }

  @Delete(":id")
  @Roles(...SALON_MANAGERS)
  @Feature(READ_OR_STOP)
  remove(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaigns.remove(req.user.tenantId, id);
  }
}
