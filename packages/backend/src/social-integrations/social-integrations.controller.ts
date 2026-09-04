import { Controller, Get, Post, Put, Delete, Param, Query, Body, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SocialIntegrationsService } from './social-integrations.service';
import { SocialPlatform } from '@prisma/client';

class UpdateConnectionSettingsDto {
  isActive?: boolean;
  autoPost?: boolean;
  notifyReviews?: boolean;
}

class CreatePostDto {
  content: string;
  mediaUrls?: string[];
  linkUrl?: string;
  platforms?: SocialPlatform[];
  scheduledAt?: string;
}

class UpdatePostDto {
  content?: string;
  mediaUrls?: string[];
  linkUrl?: string;
  platforms?: SocialPlatform[];
  scheduledAt?: string;
}

class UpdateGoogleProfileDto {
  enableOnlineBooking?: boolean;
  enableReviewRequests?: boolean;
  showRealTimeAvailability?: boolean;
}

class ReplyReviewDto {
  replyComment: string;
}

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
  async getConnections(@Query('tenantId') tenantId: string) {
    return this.socialIntegrationsService.getConnections(tenantId);
  }

  @Get('connections/:platform')
  async getConnection(
    @Query('tenantId') tenantId: string,
    @Param('platform') platform: SocialPlatform,
  ) {
    return this.socialIntegrationsService.getConnection(tenantId, platform);
  }

  @Get('oauth-url/:platform')
  async getOAuthUrl(
    @Query('tenantId') tenantId: string,
    @Param('platform') platform: SocialPlatform,
  ) {
    const url = await this.socialIntegrationsService.getOAuthUrl(tenantId, platform);
    return { url };
  }

  @Post('oauth-callback/:platform')
  async handleOAuthCallback(
    @Query('tenantId') tenantId: string,
    @Param('platform') platform: SocialPlatform,
    @Body('code') code: string,
  ) {
    return this.socialIntegrationsService.handleOAuthCallback(tenantId, platform, code);
  }

  @Post('disconnect/:platform')
  async disconnect(
    @Query('tenantId') tenantId: string,
    @Param('platform') platform: SocialPlatform,
  ) {
    return this.socialIntegrationsService.disconnect(tenantId, platform);
  }

  @Put('connections/:platform')
  async updateSettings(
    @Query('tenantId') tenantId: string,
    @Param('platform') platform: SocialPlatform,
    @Body() settings: UpdateConnectionSettingsDto,
  ) {
    return this.socialIntegrationsService.updateSettings(tenantId, platform, settings);
  }

  // ============================================
  // Google Business Profile
  // ============================================

  @Get('google-business')
  async getGoogleBusinessProfile(@Query('tenantId') tenantId: string) {
    return this.socialIntegrationsService.getGoogleBusinessProfile(tenantId);
  }

  @Put('google-business')
  async updateGoogleBusinessProfile(
    @Query('tenantId') tenantId: string,
    @Body() data: UpdateGoogleProfileDto,
  ) {
    return this.socialIntegrationsService.updateGoogleBusinessProfile(tenantId, data);
  }

  @Post('google-business/sync')
  async syncGoogleBusinessProfile(@Query('tenantId') tenantId: string) {
    return this.socialIntegrationsService.syncGoogleBusinessProfile(tenantId);
  }

  @Get('google-business/reviews')
  async getGoogleReviews(@Query('tenantId') tenantId: string) {
    return this.socialIntegrationsService.getGoogleReviews(tenantId);
  }

  @Post('google-business/reviews/:reviewId/reply')
  async replyToReview(
    @Query('tenantId') tenantId: string,
    @Param('reviewId') reviewId: string,
    @Body() data: ReplyReviewDto,
  ) {
    return this.socialIntegrationsService.replyToGoogleReview(
      tenantId,
      reviewId,
      data.replyComment,
    );
  }

  // ============================================
  // Social Posts
  // ============================================

  @Get('posts')
  async getPosts(
    @Query('tenantId') tenantId: string,
    @Query('status') status?: string,
  ) {
    return this.socialIntegrationsService.getPosts(tenantId, status);
  }

  @Post('posts')
  async createPost(
    @Query('tenantId') tenantId: string,
    @Body() data: CreatePostDto,
  ) {
    return this.socialIntegrationsService.createPost(tenantId, {
      ...data,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined });
  }

  @Put('posts/:postId')
  async updatePost(
    @Query('tenantId') tenantId: string,
    @Param('postId') postId: string,
    @Body() data: UpdatePostDto,
  ) {
    return this.socialIntegrationsService.updatePost(tenantId, postId, {
      ...data,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined });
  }

  @Delete('posts/:postId')
  async deletePost(
    @Query('tenantId') tenantId: string,
    @Param('postId') postId: string,
  ) {
    return this.socialIntegrationsService.deletePost(tenantId, postId);
  }

  @Post('posts/:postId/publish')
  async publishPost(
    @Query('tenantId') tenantId: string,
    @Param('postId') postId: string,
  ) {
    return this.socialIntegrationsService.publishPost(tenantId, postId);
  }

  @Get('analytics')
  async getAnalytics(@Query('tenantId') tenantId: string) {
    return this.socialIntegrationsService.getAnalytics(tenantId);
  }
}
