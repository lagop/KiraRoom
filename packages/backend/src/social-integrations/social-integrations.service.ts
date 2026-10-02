import { Injectable, NotFoundException, NotImplementedException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { SocialPlatform, SocialConnectionStatus } from '@prisma/client';

/**
 * Why each Google / social capability is off. These endpoints used to answer
 * with invented data: "Sample Salon" with a random rating on every "sync",
 * `mock_token_...` connections, posts "published" to example.com, replies to
 * Google reviews saved locally as if Google had them. Nothing behind them
 * talks to Google, Facebook or Instagram, so they now say so instead.
 */
export const UNAVAILABLE = {
  googleBusinessApi:
    'La conexión con Google Business Profile (leer y responder reseñas de Google, sincronizar la ficha) no está disponible: necesita que Google apruebe el acceso a su API. Mientras tanto, las clientas dejan su reseña en Google desde el enlace de tu ficha (Reseñas > Configuración).',
  oauth: (platform: string) =>
    `La conexión con ${platform} todavía no está disponible.`,
  publish:
    'Publicar en redes sociales todavía no está disponible: la publicación queda guardada como borrador.',
} as const;

@Injectable()
export class SocialIntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================
  // Social Connections Management
  // ============================================

  async getConnections(tenantId: string) {
    return this.prisma.socialConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

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
   * No OAuth flow is implemented for any platform: the URL used to be built
   * with `client_id=undefined`, and the callback stored a mock token.
   */
  async getOAuthUrl(_tenantId: string, platform: SocialPlatform): Promise<string> {
    throw new NotImplementedException(
      platform === SocialPlatform.GOOGLE ? UNAVAILABLE.googleBusinessApi : UNAVAILABLE.oauth(platform),
    );
  }

  async handleOAuthCallback(_tenantId: string, platform: SocialPlatform, _code: string): Promise<never> {
    throw new NotImplementedException(
      platform === SocialPlatform.GOOGLE ? UNAVAILABLE.googleBusinessApi : UNAVAILABLE.oauth(platform),
    );
  }

  async disconnect(tenantId: string, platform: SocialPlatform) {
    await this.getConnection(tenantId, platform);
    return this.prisma.socialConnection.update({
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
  }

  async updateSettings(
    tenantId: string,
    platform: SocialPlatform,
    settings: {
      isActive?: boolean;
      autoPost?: boolean;
      notifyReviews?: boolean;
    },
  ) {
    await this.getConnection(tenantId, platform);
    return this.prisma.socialConnection.update({
      where: {
        tenantId_platform: { tenantId, platform },
      },
      data: settings,
    });
  }

  // ============================================
  // Google Business Profile
  // ============================================

  /**
   * What KiraRoom knows about the salon's Google profile: only what the salon
   * entered (its review link). `api.available` is false because there is no
   * Business Profile API integration; the synced fields stay empty.
   */
  async getGoogleBusinessProfile(tenantId: string) {
    const profile = await this.prisma.googleBusinessProfile.findUnique({
      where: { tenantId },
    });
    return {
      profile,
      api: { available: false, reason: UNAVAILABLE.googleBusinessApi },
    };
  }

  /**
   * Only the review-request switch is stored. "Reserve with Google" and
   * real-time availability on Google were toggles that switched nothing on.
   */
  async updateGoogleBusinessProfile(
    tenantId: string,
    data: { enableReviewRequests?: boolean },
  ) {
    const update =
      data.enableReviewRequests === undefined ? {} : { enableReviewRequests: data.enableReviewRequests };
    const profile = await this.prisma.googleBusinessProfile.upsert({
      where: { tenantId },
      update,
      create: { tenantId, ...update },
    });
    return {
      profile,
      api: { available: false, reason: UNAVAILABLE.googleBusinessApi },
    };
  }

  async syncGoogleBusinessProfile(_tenantId: string): Promise<never> {
    throw new NotImplementedException(UNAVAILABLE.googleBusinessApi);
  }

  async getGoogleReviews(_tenantId: string): Promise<never> {
    throw new NotImplementedException(UNAVAILABLE.googleBusinessApi);
  }

  async replyToGoogleReview(_tenantId: string, _reviewId: string, _replyComment: string): Promise<never> {
    throw new NotImplementedException(UNAVAILABLE.googleBusinessApi);
  }

  // ============================================
  // Social Posts
  // ============================================

  async getPosts(tenantId: string, status?: string) {
    return this.prisma.socialPost.findMany({
      where: {
        tenantId,
        ...(status ? { status } : {}),
      },
      orderBy: { scheduledAt: 'desc' },
    });
  }

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
    // Always a draft: nothing would publish a "scheduled" post.
    return this.prisma.socialPost.create({
      data: {
        tenantId,
        content: data.content,
        mediaUrls: data.mediaUrls || [],
        linkUrl: data.linkUrl,
        platforms: data.platforms || [],
        scheduledAt: data.scheduledAt,
        status: 'draft',
      },
    });
  }

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
    await this.findPost(tenantId, postId);
    return this.prisma.socialPost.update({
      where: { id: postId },
      data,
    });
  }

  async deletePost(tenantId: string, postId: string) {
    await this.findPost(tenantId, postId);
    await this.prisma.socialPost.delete({
      where: { id: postId },
    });

    return { success: true };
  }

  async publishPost(tenantId: string, postId: string): Promise<never> {
    await this.findPost(tenantId, postId);
    throw new NotImplementedException(UNAVAILABLE.publish);
  }

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

  /** Posts were updated and deleted by id alone, from any salon. */
  private async findPost(tenantId: string, postId: string) {
    const post = await this.prisma.socialPost.findFirst({
      where: { id: postId, tenantId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Publicación no encontrada');
    return post;
  }
}
