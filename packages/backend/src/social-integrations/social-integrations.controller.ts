import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
  ParseEnumPipe,
  ParseUUIDPipe,
} from "@nestjs/common";
import type { Request } from "express";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from "class-validator";
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SocialIntegrationsService } from './social-integrations.service';
import { SocialPlatform } from '@prisma/client';
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

// Every field needs a validator: the global ValidationPipe strips the rest,
// and these DTOs had none, so every body arrived empty.

class UpdateConnectionSettingsDto {
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() autoPost?: boolean;
  @IsOptional() @IsBoolean() notifyReviews?: boolean;
}

class CreatePostDto {
  @IsString() @MaxLength(5000) content!: string;
  @IsOptional() @IsArray() @IsUrl({}, { each: true }) mediaUrls?: string[];
  @IsOptional() @IsUrl() linkUrl?: string;
  @IsOptional() @IsArray() @IsEnum(SocialPlatform, { each: true }) platforms?: SocialPlatform[];
  @IsOptional() @IsDateString() scheduledAt?: string;
}

class UpdatePostDto {
  @IsOptional() @IsString() @MaxLength(5000) content?: string;
  @IsOptional() @IsArray() @IsUrl({}, { each: true }) mediaUrls?: string[];
  @IsOptional() @IsUrl() linkUrl?: string;
  @IsOptional() @IsArray() @IsEnum(SocialPlatform, { each: true }) platforms?: SocialPlatform[];
  @IsOptional() @IsDateString() scheduledAt?: string;
}

class UpdateGoogleProfileDto {
  @IsOptional() @IsBoolean() enableReviewRequests?: boolean;
}

class ReplyReviewDto {
  @IsString() @MaxLength(4000) replyComment!: string;
}

class OAuthCallbackDto {
  @IsString() @MaxLength(2000) code!: string;
}

const platformPipe = new ParseEnumPipe(SocialPlatform);

/**
 * The tenant comes from the session. It used to come from a `tenantId`
 * query parameter, which the frontend never sent (so Prisma got
 * `undefined`, meaning "no filter") and which anyone could set to another
 * salon's id.
 */
@Controller('social-integrations')
@UseGuards(JwtAuthGuard)
export class SocialIntegrationsController {
  constructor(
    private readonly socialIntegrationsService: SocialIntegrationsService,
  ) {}

  // ============================================
  // Social Connections
  // ============================================

  @Get('connections')
  @Roles(...SALON_MANAGERS)
  async getConnections(@Req() req: AuthedRequest) {
    return this.socialIntegrationsService.getConnections(req.user.tenantId);
  }

  @Get('connections/:platform')
  @Roles(...SALON_MANAGERS)
  async getConnection(
    @Req() req: AuthedRequest,
    @Param('platform', platformPipe) platform: SocialPlatform,
  ) {
    return this.socialIntegrationsService.getConnection(req.user.tenantId, platform);
  }

  @Get('oauth-url/:platform')
  @Roles(...SALON_MANAGERS)
  async getOAuthUrl(
    @Req() req: AuthedRequest,
    @Param('platform', platformPipe) platform: SocialPlatform,
  ) {
    const url = await this.socialIntegrationsService.getOAuthUrl(req.user.tenantId, platform);
    return { url };
  }

  @Post('oauth-callback/:platform')
  @Roles(...SALON_MANAGERS)
  async handleOAuthCallback(
    @Req() req: AuthedRequest,
    @Param('platform', platformPipe) platform: SocialPlatform,
    @Body() body: OAuthCallbackDto,
  ) {
    return this.socialIntegrationsService.handleOAuthCallback(req.user.tenantId, platform, body.code);
  }

  @Post('disconnect/:platform')
  @Roles(...SALON_MANAGERS)
  async disconnect(
    @Req() req: AuthedRequest,
    @Param('platform', platformPipe) platform: SocialPlatform,
  ) {
    return this.socialIntegrationsService.disconnect(req.user.tenantId, platform);
  }

  @Put('connections/:platform')
  @Roles(...SALON_MANAGERS)
  async updateSettings(
    @Req() req: AuthedRequest,
    @Param('platform', platformPipe) platform: SocialPlatform,
    @Body() settings: UpdateConnectionSettingsDto,
  ) {
    return this.socialIntegrationsService.updateSettings(req.user.tenantId, platform, settings);
  }

  // ============================================
  // Google Business Profile
  // ============================================

  @Get('google-business')
  @Roles(...SALON_MANAGERS)
  async getGoogleBusinessProfile(@Req() req: AuthedRequest) {
    return this.socialIntegrationsService.getGoogleBusinessProfile(req.user.tenantId);
  }

  @Put('google-business')
  @Roles(...SALON_MANAGERS)
  async updateGoogleBusinessProfile(
    @Req() req: AuthedRequest,
    @Body() data: UpdateGoogleProfileDto,
  ) {
    return this.socialIntegrationsService.updateGoogleBusinessProfile(req.user.tenantId, data);
  }

  @Post('google-business/sync')
  @Roles(...SALON_MANAGERS)
  async syncGoogleBusinessProfile(@Req() req: AuthedRequest) {
    return this.socialIntegrationsService.syncGoogleBusinessProfile(req.user.tenantId);
  }

  @Get('google-business/reviews')
  @Roles(...SALON_MANAGERS)
  async getGoogleReviews(@Req() req: AuthedRequest) {
    return this.socialIntegrationsService.getGoogleReviews(req.user.tenantId);
  }

  @Post('google-business/reviews/:reviewId/reply')
  @Roles(...SALON_MANAGERS)
  async replyToReview(
    @Req() req: AuthedRequest,
    @Param('reviewId') reviewId: string,
    @Body() data: ReplyReviewDto,
  ) {
    return this.socialIntegrationsService.replyToGoogleReview(
      req.user.tenantId,
      reviewId,
      data.replyComment,
    );
  }

  // ============================================
  // Social Posts
  // ============================================

  @Get('posts')
  @Roles(...SALON_MANAGERS)
  async getPosts(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
  ) {
    return this.socialIntegrationsService.getPosts(req.user.tenantId, status);
  }

  @Post('posts')
  @Roles(...SALON_MANAGERS)
  async createPost(
    @Req() req: AuthedRequest,
    @Body() data: CreatePostDto,
  ) {
    return this.socialIntegrationsService.createPost(req.user.tenantId, {
      ...data,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined });
  }

  @Put('posts/:postId')
  @Roles(...SALON_MANAGERS)
  async updatePost(
    @Req() req: AuthedRequest,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() data: UpdatePostDto,
  ) {
    return this.socialIntegrationsService.updatePost(req.user.tenantId, postId, {
      ...data,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined });
  }

  @Delete('posts/:postId')
  @Roles(...SALON_MANAGERS)
  async deletePost(
    @Req() req: AuthedRequest,
    @Param('postId', ParseUUIDPipe) postId: string,
  ) {
    return this.socialIntegrationsService.deletePost(req.user.tenantId, postId);
  }

  @Post('posts/:postId/publish')
  @Roles(...SALON_MANAGERS)
  async publishPost(
    @Req() req: AuthedRequest,
    @Param('postId', ParseUUIDPipe) postId: string,
  ) {
    return this.socialIntegrationsService.publishPost(req.user.tenantId, postId);
  }

  @Get('analytics')
  @Roles(...SALON_MANAGERS)
  async getAnalytics(@Req() req: AuthedRequest) {
    return this.socialIntegrationsService.getAnalytics(req.user.tenantId);
  }
}
