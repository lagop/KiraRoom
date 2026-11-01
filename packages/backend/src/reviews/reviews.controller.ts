import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { ReviewStatus } from "@prisma/client";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { Type } from "class-transformer";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Public } from "../auth/decorators/public.decorator";
import { ReviewsService } from "./reviews.service";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { REVIEW_REJECTION_REASONS } from "./review-rules";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

export class ModerateReviewDto {
  @IsIn(["approve", "reject"])
  action!: "approve" | "reject";

  /** Required to reject or hide: one of REVIEW_REJECTION_REASONS (review-rules.ts). */
  @ValidateIf((o) => o.action === "reject")
  @IsIn([...REVIEW_REJECTION_REASONS], {
    message: "Elige el motivo: insultos o contenido ofensivo, datos personales, no habla del servicio, o spam o duplicada",
  })
  reason?: string;
}

export class UpdateReviewSettingsDto {
  /** Empty string or null clears it. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  googlePlaceId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  googleWriteReviewUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  autoRequestsEnabled?: boolean;
}

export class SubmitReviewDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;

  /** The unticked box: "Pueden mostrar mi opinión en su web con mi nombre e inicial". */
  @IsOptional()
  @IsBoolean()
  publishConsent?: boolean;
}

const STATUSES = Object.values(ReviewStatus) as string[];

@ApiTags("reviews")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("reviews")
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Get()
  @Roles(...SALON_MANAGERS)
  list(
    @Req() req: AuthedRequest,
    @Query("rating") rating?: string,
    @Query("professionalId") professionalId?: string,
    @Query("status") status?: string,
  ) {
    if (status && !STATUSES.includes(status)) throw new BadRequestException("status no válido");
    const stars = rating ? Number(rating) : undefined;
    return this.service.listForTenant(req.user.tenantId, {
      rating: stars && stars >= 1 && stars <= 5 ? stars : undefined,
      professionalId: professionalId || undefined,
      status: (status as ReviewStatus) || undefined,
    });
  }

  @Get("settings")
  @Roles(...SALON_MANAGERS)
  settings(@Req() req: AuthedRequest) {
    return this.service.getSettings(req.user.tenantId);
  }

  @Put("settings")
  @Roles(...SALON_MANAGERS)
  updateSettings(@Req() req: AuthedRequest, @Body() body: UpdateReviewSettingsDto) {
    return this.service.updateSettings(req.user.tenantId, body);
  }

  /** Submits the WhatsApp review template to Meta; answers the settings with its status. */
  @Post("settings/whatsapp-template")
  @Roles(...SALON_MANAGERS)
  submitWhatsAppTemplate(@Req() req: AuthedRequest) {
    return this.service.submitWhatsAppTemplate(req.user.tenantId);
  }

  @Post(":id/moderate")
  @Roles(...SALON_MANAGERS)
  moderate(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ModerateReviewDto,
  ) {
    return this.service.moderate(req.user.tenantId, id, body.action, body.reason, {
      id: req.user.id,
      role: req.user.role,
    });
  }
}

/**
 * The page a client reaches from the review request. The token in the link
 * is the only credential: it identifies one request, and expires 14 days
 * after it was sent.
 */
@ApiTags("reviews-public")
@Controller("public/r")
export class ReviewsPublicController {
  constructor(private readonly service: ReviewsService) {}

  @Get(":token")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  get(@Param("token") token: string) {
    return this.service.getPublic(token);
  }

  @Post(":token")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  submit(@Param("token") token: string, @Body() body: SubmitReviewDto) {
    return this.service.submit(token, body);
  }

  @Post(":token/google-click")
  @Public()
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  googleClick(@Param("token") token: string) {
    return this.service.recordGoogleClick(token);
  }

  @Post(":token/opt-out")
  @Public()
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  optOut(@Param("token") token: string) {
    return this.service.optOut(token);
  }
}

/** Approved reviews shown on the salon's booking page. */
@ApiTags("reviews-public")
@Controller("public/reviews")
export class ReviewsPublicListController {
  constructor(private readonly service: ReviewsService) {}

  @Get("tenant/:tenantId")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  forTenant(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.service.publicForTenant(tenantId);
  }
}

@ApiTags("reviews-analytics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("analytics/reviews")
export class ReviewsAnalyticsController {
  constructor(private readonly service: ReviewsService) {}

  @Get()
  @Roles(...SALON_MANAGERS)
  async analytics(
    @Req() req: AuthedRequest,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const parse = (v?: string) => {
      if (!v) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    return this.service.analytics(req.user.tenantId, parse(from), parse(to));
  }
}
