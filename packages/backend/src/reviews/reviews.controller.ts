import { ParseUUIDPipe, Controller, Get, Post, Body, Param, Query, Req, UseGuards, Res, BadRequestException, NotFoundException } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Public } from "../auth/decorators/public.decorator";
import { ReviewsService } from "./reviews.service";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

@ApiTags("reviews")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("reviews")
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Get()
  list(
    @Req() req: AuthedRequest,
    @Query("rating") rating?: string,
    @Query("professionalId") professionalId?: string,
    @Query("status") status?: any,
  ) {
    return this.service.listForTenant(req.user.tenantId, {
      rating: rating ? Number(rating) : undefined,
      professionalId,
      status,
    });
  }

  @Post(":id/moderate")
  moderate(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { action: "approve" | "reject" },
  ) {
    if (!body?.action) throw new BadRequestException("action required");
    return this.service.moderate(req.user.tenantId, id, body.action);
  }
}

@ApiTags("reviews-public")
@Controller("public/r")
export class ReviewsPublicController {
  constructor(private readonly service: ReviewsService) {}

  @Get(":token")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async getByToken(@Param("token") token: string, @Res() res: Response) {
    const review = await this.service["prisma"].review.findUnique({
      where: { reviewToken: token },
    });
    if (!review) throw new NotFoundException("Review link invalid");
    if (review.reviewTokenExpiresAt && review.reviewTokenExpiresAt < new Date()) {
      throw new BadRequestException("Token expired");
    }
    const tenant = await this.service["prisma"].tenant.findUnique({
      where: { id: review.tenantId },
      select: { id: true, name: true, slug: true, logo: true },
    });
    const appointment = review.appointmentId
      ? await this.service["prisma"].appointment
          .findUnique({
            where: { id: review.appointmentId },
            include: {
              professional: { select: { firstName: true, lastName: true } },
              service: { select: { name: true } },
            },
          })
          .catch(() => null)
      : null;
    const googleLink = await this.service.buildGoogleReviewLink(review.tenantId);
    return res.json({
      tenant,
      professional: appointment?.professional,
      service: appointment?.service,
      googleReviewLink: googleLink,
    });
  }

  @Post(":token")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  publish(@Param("token") token: string, @Body() body: any) {
    return this.service.publish(token, {
      rating: body.rating,
      comment: body.comment,
      publishToGoogle: body.publishToGoogle,
    });
  }
}

@ApiTags("reviews-analytics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("analytics/reviews")
export class ReviewsAnalyticsController {
  constructor(private readonly service: ReviewsService) {}

  @Get()
  async analytics(
    @Req() req: AuthedRequest,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.service.analytics(
      req.user.tenantId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }
}