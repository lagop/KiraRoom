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
 * WhatsApp campaigns of the signed-in salon. Every route takes the salon
 * from the session: the old endpoints sent or reported any campaign by id.
 */
@ApiTags("whatsapp")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@Feature("whatsapp_notifications")
@Controller("whatsapp/campaigns")
export class WhatsAppCampaignsController {
  constructor(private readonly campaigns: WhatsAppCampaignsService) {}

  @Get()
  @Roles(...SALON_MANAGERS)
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

  @Get(":id")
  @Roles(...SALON_MANAGERS)
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
  cancel(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaigns.cancel(req.user.tenantId, id);
  }

  @Delete(":id")
  @Roles(...SALON_MANAGERS)
  remove(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaigns.remove(req.user.tenantId, id);
  }
}
