import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { SocialPlatform, SocialConnectionStatus } from '@prisma/client';

@Injectable()
export class SocialIntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================
  // Social Connections Management
  // ============================================

  /**
   * Get all social connections for a tenant
   */
  async getConnections(tenantId: string) {
    return this.prisma.socialConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get a specific social connection
   */
  async getConnection(tenantId: string, platform: SocialPlatform) {
    const connection = await this.prisma.socialConnection.findUnique({
      where: {
        tenantId_platform: { tenantId, platform },
      },
    });

    if (!connection) {
      throw new NotFoundException(`No connection found for platform: ${platform}`);
    }

    return connection;
  }

  /**
   * Create OAuth URL for connecting a social platform
   */
  async getOAuthUrl(tenantId: string, platform: SocialPlatform): Promise<string> {
    // This would integrate with actual OAuth flows
    // For now, return placeholder URLs that would be configured with actual OAuth credentials
    const baseUrls: Record<SocialPlatform, string> = {
      GOOGLE: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=openid%20email%20profile%20https://www.googleapis.com/auth/business.manage`,
      FACEBOOK: `https://www.facebook.com/v18.0/dialog/oauth?client_id=${process.env.FACEBOOK_APP_ID}&redirect_uri=${process.env.FACEBOOK_REDIRECT_URI}&scope=pages_manage_posts,pages_read_engagement`,
      INSTAGRAM: `https://api.instagram.com/oauth/authorize?client_id=${process.env.INSTAGRAM_APP_ID}&redirect_uri=${process.env.INSTAGRAM_REDIRECT_URI}&scope=user_profile,user_media`,
      TWITTER: '',
      TIKTOK: '',
    };

    return baseUrls[platform] || '';
  }

  /**
   * Handle OAuth callback and create/update connection
   */
  async handleOAuthCallback(
    tenantId: string,
    platform: SocialPlatform,
    code: string,
  ) {
    // In production, this would exchange the code for tokens
    // For now, we'll create a mock connection
    const connection = await this.prisma.socialConnection.upsert({
      where: {
        tenantId_platform: { tenantId, platform },
      },
      update: {
        status: SocialConnectionStatus.CONNECTED,
        accessToken: `mock_token_${Date.now()}`,
        tokenExpiry: new Date(Date.now() + 3600000), // 1 hour
        lastSyncAt: new Date(),
        syncError: null,
      },
      create: {
        tenantId,
        platform,
        status: SocialConnectionStatus.CONNECTED,
        accessToken: `mock_token_${Date.now()}`,
        tokenExpiry: new Date(Date.now() + 3600000),
        accountName: `${platform} Account`,
      },
    });

    return connection;
  }

  /**
   * Disconnect a social platform
   */
  async disconnect(tenantId: string, platform: SocialPlatform) {
    const connection = await this.prisma.socialConnection.update({
      where: {
        tenantId_platform: { tenantId, platform },
      },
      data: {
        status: SocialConnectionStatus.DISCONNECTED,
        accessToken: null,
        refreshToken: null,
        tokenExpiry: null,
      },
    });

    return connection;
  }

  /**
   * Update connection settings
   */
  async updateSettings(
    tenantId: string,
    platform: SocialPlatform,
    settings: {
      isActive?: boolean;
      autoPost?: boolean;
      notifyReviews?: boolean;
    },
  ) {
    const connection = await this.prisma.socialConnection.update({
      where: {
        tenantId_platform: { tenantId, platform },
      },
      data: settings,
    });

    return connection;
  }

  // ============================================
  // Google Business Profile
  // ============================================

  /**
   * Get Google Business Profile for a tenant
   */
  async getGoogleBusinessProfile(tenantId: string) {
    let profile = await this.prisma.googleBusinessProfile.findUnique({
      where: { tenantId },
      include: { reviews: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });

    if (!profile) {
      // Create a placeholder profile
      profile = await this.prisma.googleBusinessProfile.create({
        data: { tenantId },
        include: { reviews: true },
      });
    }

    return profile;
  }

  /**
   * Update Google Business Profile settings
   */
  async updateGoogleBusinessProfile(
    tenantId: string,
    data: {
      enableOnlineBooking?: boolean;
      enableReviewRequests?: boolean;
      showRealTimeAvailability?: boolean;
    },
  ) {
    const profile = await this.prisma.googleBusinessProfile.upsert({
      where: { tenantId },
      update: data,
      create: { tenantId, ...data },
    });

    return profile;
  }

  /**
   * Sync Google Business Profile data
   * In production, this would call the Google My Business API
   */
  async syncGoogleBusinessProfile(tenantId: string) {
    // Mock sync - in production would call Google API
    const profile = await this.prisma.googleBusinessProfile.update({
      where: { tenantId },
      data: {
        lastSyncAt: new Date(),
        // Mock data
        businessName: 'Sample Salon',
        totalReviews: Math.floor(Math.random() * 100),
        averageRating: 4.0 + Math.random() * 1,
        profileComplete: true,
      },
    });

    return profile;
  }

  /**
   * Get Google reviews
   */
  async getGoogleReviews(tenantId: string) {
    const profile = await this.prisma.googleBusinessProfile.findUnique({
      where: { tenantId },
      include: { reviews: { orderBy: { createdAt: 'desc' } } },
    });

    if (!profile) {
      throw new NotFoundException('Google Business Profile not found');
    }

    return profile.reviews;
  }

  /**
   * Reply to a Google review
   */
  async replyToGoogleReview(tenantId: string, reviewId: string, replyComment: string) {
    const review = await this.prisma.googleReview.update({
      where: { id: reviewId },
      data: {
        replyComment,
        replyAt: new Date(),
      },
    });

    return review;
  }

  // ============================================
  // Social Posts
  // ============================================

  /**
   * Get all social posts for a tenant
   */
  async getPosts(tenantId: string, status?: string) {
    return this.prisma.socialPost.findMany({
      where: {
        tenantId,
        ...(status ? { status } : {}),
      },
      orderBy: { scheduledAt: 'desc' },
    });
  }

  /**
   * Create a social post
   */
  async createPost(
    tenantId: string,
    data: {
      content: string;
      mediaUrls?: string[];
      linkUrl?: string;
      platforms?: SocialPlatform[];
      scheduledAt?: Date;
    },
  ) {
    const post = await this.prisma.socialPost.create({
      data: {
        tenantId,
        content: data.content,
        mediaUrls: data.mediaUrls || [],
        linkUrl: data.linkUrl,
        platforms: data.platforms || [],
        scheduledAt: data.scheduledAt,
        status: data.scheduledAt ? 'scheduled' : 'draft',
      },
    });

    return post;
  }

  /**
   * Update a social post
   */
  async updatePost(
    tenantId: string,
    postId: string,
    data: {
      content?: string;
      mediaUrls?: string[];
      linkUrl?: string;
      platforms?: SocialPlatform[];
      scheduledAt?: Date;
    },
  ) {
    const post = await this.prisma.socialPost.update({
      where: { id: postId },
      data: {
        ...data,
        ...(data.scheduledAt ? { status: 'scheduled' } : {}),
      },
    });

    return post;
  }

  /**
   * Delete a social post
   */
  async deletePost(tenantId: string, postId: string) {
    await this.prisma.socialPost.delete({
      where: { id: postId },
    });

    return { success: true };
  }

  /**
   * Publish a social post
   * In production, this would actually post to the social platforms
   */
  async publishPost(tenantId: string, postId: string) {
    const post = await this.prisma.socialPost.update({
      where: { id: postId },
      data: {
        status: 'published',
        publishedAt: new Date(),
        platformPostId: `mock_post_${Date.now()}`,
        platformUrl: 'https://example.com/post',
      },
    });

    return post;
  }

  /**
   * Get social analytics
   */
  async getAnalytics(tenantId: string) {
    const posts = await this.prisma.socialPost.findMany({
      where: { tenantId, status: 'published' },
    });

    const totalPosts = posts.length;
    const totalLikes = posts.reduce((sum, p) => sum + p.likes, 0);
    const totalComments = posts.reduce((sum, p) => sum + p.comments, 0);
    const totalShares = posts.reduce((sum, p) => sum + p.shares, 0);
    const totalClicks = posts.reduce((sum, p) => sum + p.clicks, 0);

    return {
      totalPosts,
      totalLikes,
      totalComments,
      totalShares,
      totalClicks,
      engagementRate: totalPosts > 0 
        ? ((totalLikes + totalComments + totalShares) / totalPosts).toFixed(2)
        : 0,
    };
  }
}
