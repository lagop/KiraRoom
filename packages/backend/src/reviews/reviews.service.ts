import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma/prisma.service";
import { ReviewSource, ReviewStatus, AppointmentStatus } from "@prisma/client";
import { createHmac, randomBytes } from "crypto";
import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private notificationsService: NotificationsService,
  ) {}

  async listForTenant(tenantId: string, opts: {
    rating?: number;
    professionalId?: string;
    status?: ReviewStatus;
    from?: Date;
    to?: Date;
  } = {}) {
    return this.prisma.review.findMany({
      where: {
        tenantId,
        ...(opts.rating ? { rating: opts.rating } : {}),
        ...(opts.professionalId ? { professionalId: opts.professionalId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.from || opts.to
          ? {
              createdAt: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lte: opts.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async analytics(tenantId: string, from?: Date, to?: Date) {
    const where = {
      tenantId,
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };
    const reviews = await this.prisma.review.findMany({
      where,
      select: { rating: true, professionalId: true },
    });
    const total = reviews.length;
    const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
    const distribution = [0, 0, 0, 0, 0];
    for (const r of reviews) distribution[r.rating - 1]++;
    const byProf = new Map<string, { count: number; sum: number }>();
    for (const r of reviews) {
      if (!r.professionalId) continue;
      const entry = byProf.get(r.professionalId) ?? { count: 0, sum: 0 };
      entry.count++;
      entry.sum += r.rating;
      byProf.set(r.professionalId, entry);
    }
    const topPerformers = Array.from(byProf.entries())
      .map(([professionalId, v]) => ({
        professionalId,
        averageRating: v.count ? Number((v.sum / v.count).toFixed(2)) : 0,
        count: v.count,
      }))
      .sort((a, b) => b.averageRating - a.averageRating)
      .slice(0, 10);
    return {
      averageRating: total ? Number((sum / total).toFixed(2)) : 0,
      total,
      distribution,
      topPerformers,
    };
  }

  async moderate(tenantId: string, id: string, action: "approve" | "reject") {
    const r = await this.prisma.review.findFirst({ where: { id, tenantId } });
    if (!r) throw new NotFoundException("Review not found");
    return this.prisma.review.update({
      where: { id },
      data: { status: action === "approve" ? ReviewStatus.published : ReviewStatus.rejected },
    });
  }

  async publish(token: string, input: { rating: number; comment?: string; publishToGoogle?: boolean }) {
    if (!token) throw new BadRequestException("token required");
    if (!input.rating || input.rating < 1 || input.rating > 5) {
      throw new BadRequestException("rating must be 1-5");
    }
    const review = await this.prisma.review.findUnique({ where: { reviewToken: token } });
    if (!review) throw new NotFoundException("Invalid or expired token");
    if (review.reviewTokenExpiresAt && review.reviewTokenExpiresAt < new Date()) {
      throw new BadRequestException("Token expired");
    }
    const updated = await this.prisma.review.update({
      where: { id: review.id },
      data: {
        rating: input.rating,
        comment: input.comment ?? null,
        publishedToGoogle: !!input.publishToGoogle,
        reviewToken: null,
        reviewTokenExpiresAt: null,
        status: ReviewStatus.published,
      },
    });
    // Optionally mark appointment review-requested fields
    if (review.appointmentId) {
      await this.prisma.appointment.update({
        where: { id: review.appointmentId },
        data: { rating: input.rating, review: input.comment ?? null },
      });
    }
    return updated;
  }

  async buildGoogleReviewLink(tenantId: string): Promise<string | null> {
    const gbp = await this.prisma.googleBusinessProfile.findUnique({
      where: { tenantId },
    });
    if (!gbp?.locationId) return null;
    return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(gbp.locationId)}`;
  }

  /**
   * Cron: every day at 14:00 find appointments completed >24h ago without a
   * review request, generate HMAC token, persist pending Review, and trigger
   * a notification containing the magic link.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2PM)
  async dispatchReviewRequests() {
    this.logger.log("ReviewsDispatcher: scanning completed appointments");
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const candidates = await this.prisma.appointment.findMany({
        where: {
          status: AppointmentStatus.completed,
          reviewRequestSent: false,
          completionTime: { lt: cutoff, not: null },
        },
        include: { tenant: true, client: true },
        take: 200,
      });
      this.logger.log(`Review dispatcher: ${candidates.length} candidates`);
      for (const appt of candidates) {
        if (!appt.client?.email) continue;
        const token = this.signReviewToken(appt.id);
        const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
        await this.prisma.review.upsert({
          where: { id: `${appt.id}-review` },
          update: {},
          create: {
            id: `${appt.id}-review`,
            tenantId: appt.tenantId,
            appointmentId: appt.id,
            clientId: appt.clientId,
            professionalId: appt.professionalId,
            rating: 0,
            source: ReviewSource.email_link,
            status: ReviewStatus.pending,
            reviewToken: token,
            reviewTokenExpiresAt: expires,
          },
        });
        const frontend =
          this.config.get<string>("FRONTEND_URL") || "http://localhost:3000";
        const link = `${frontend.replace(/\/$/, "")}/r/${token}`;
        try {
          await this.notificationsService.create({
            tenantId: appt.tenantId,
            clientId: appt.clientId,
            type: "review_request" as any,
            title: "Cuéntanos cómo fue tu visita",
            message: `Tu opinión nos ayuda a mejorar. Pulsa aquí: ${link}`,
            data: { appointmentId: appt.id, link },
          });
        } catch (err: any) {
          this.logger.warn(`Notification skipped: ${err.message}`);
        }
        await this.prisma.appointment.update({
          where: { id: appt.id },
          data: { reviewRequestSent: true },
        });
      }
    } catch (err: any) {
      this.logger.error(`ReviewsDispatcher failed: ${err.message}`);
    }
  }

  private signReviewToken(appointmentId: string): string {
    const secret =
      this.config.get<string>("JWT_SECRET") || "kira-dev-fallback-secret";
    const nonce = randomBytes(8).toString("hex");
    const sig = createHmac("sha256", secret)
      .update(`${appointmentId}.${nonce}`)
      .digest("hex")
      .slice(0, 32);
    return `${nonce}${sig}`;
  }
}