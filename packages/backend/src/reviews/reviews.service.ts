import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import { AppointmentStatus, Prisma, ReviewSource, ReviewStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationType } from "../notifications/dto";
import { EmailService } from "../notifications/services/email.service";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { EmailSuppressionService } from "../email-campaigns/email-suppression.service";
import { AuditLogService } from "../saas/audit-log.service";
import { reviewEmailPoints } from "../loyalty/loyalty-client-points";
import { WhatsAppTemplateService } from "../whatsapp/whatsapp-template.service";
import { REVIEW_REQUEST } from "../whatsapp/whatsapp-templates";
import { MARKETING_FIELD_ID, WHATSAPP_NOTICES_PURPOSE } from "../consent/marketing-consent";
import { noticeChannelsOf, salonWhatsAppConnected } from "../consent/client-notices";
import {
  LEGACY_REJECTION_REASON,
  LISTABLE_CONSENTS,
  MODERATION_GRACE_DAYS,
  PUBLISH_CONSENT_VERSION,
  REJECTION_REASON_LABEL,
  isRejectionReason,
  withinSendingHours,
} from "./review-rules";

/** The add-on that pays for automatic review requests. */
export const REVIEW_ADDON_KEY = "google_reviews_auto" as const;
/** Hours after the appointment is completed before asking: the client is home, not at the till. */
export const REQUEST_DELAY_HOURS = 2;
/**
 * Visits older than this are never chased: neither one that started longer
 * ago nor one marked completed longer ago. Without it, a salon switching the
 * requests on (or completing last month's appointments today) would email
 * every client it ever served.
 */
export const REQUEST_WINDOW_HOURS = 72;
/** A request whose send failed is tried this many times in all, on later ticks. */
export const MAX_REQUEST_ATTEMPTS = 3;
/** A regular client is asked at most once in this many days, however often she comes. */
export const CLIENT_COOLDOWN_DAYS = 30;
export const TOKEN_TTL_DAYS = 14;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

/** Statuses whose rating counts in the average: everything answered but rejected. */
const COUNTED_STATUSES: ReviewStatus[] = [ReviewStatus.moderation, ReviewStatus.published];

/** The listed reasons, for the panel and the public rules (not the legacy one). */
const REASON_OPTIONS = Object.entries(REJECTION_REASON_LABEL)
  .filter(([key]) => key !== LEGACY_REJECTION_REASON)
  .map(([key, label]) => ({ key, label }));

/**
 * Google's "write a review" link for a Place ID. Needs no API access: it is
 * the link Google itself gives a business owner to share. When the salon
 * filled in both, the Place ID wins: the link is built from it and cannot be
 * mistyped.
 */
export function googleWriteReviewLink(profile: {
  placeId?: string | null;
  writeReviewUrl?: string | null;
} | null): string | null {
  if (!profile) return null;
  if (profile.placeId) {
    return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(profile.placeId)}`;
  }
  // A link saved before the host list was narrowed is not handed out.
  return profile.writeReviewUrl && isGoogleReviewUrl(profile.writeReviewUrl) ? profile.writeReviewUrl : null;
}

/**
 * Only https links to where Google takes reviews: the short links Google
 * gives a business (g.page, maps.app.goo.gl), its "write a review" page,
 * and Google Maps (www.google.<tld>/maps). The link is shown to the salon's
 * clients on a KiraRoom page as "your Google review page", so it must not be
 * able to point anywhere else -- not even another Google service.
 */
export function isGoogleReviewUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === "g.page" || host === "maps.app.goo.gl") return true;
  if (host === "search.google.com") return path === "/local/writereview" || path.startsWith("/local/writereview/");
  if (/^www\.google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)) return path === "/maps" || path.startsWith("/maps/");
  return false;
}

interface CandidateAppointment {
  id: string;
  tenantId: string;
  clientId: string;
  professionalId: string | null;
  reviewRequestAttempts: number;
  serviceName?: string | null;
  client: {
    id: string;
    firstName: string;
    email: string | null;
    phone?: string | null;
    communicationPreferences?: unknown;
    status: string;
  } | null;
  service: { name: string } | null;
  tenant: { name: string; country?: string | null };
}

/**
 * Where the salon's WhatsApp review template stands, for the settings:
 * "not_connected", "NOT_SUBMITTED", Meta's status (PENDING, APPROVED,
 * REJECTED, PAUSED, DISABLED...) or "unknown" when Meta could not be asked.
 */
export type WhatsAppReviewChannel = string;

/** What one try did: sent, failed and worth retrying, or can never go. */
export type RequestOutcome = "sent" | "failed" | "skipped";

export interface ReviewModerator {
  id: string;
  role: string;
}

/**
 * Reviews: the post-visit request, the client's answer on the public page,
 * moderation in the panel, and the hand-off to the salon's Google page.
 *
 * What it does not do is talk to Google. Reading or answering Google reviews
 * needs the Business Profile API, which Google grants per project after a
 * review, plus each salon's OAuth consent; none of that exists, so the
 * client is sent to Google's own "write a review" page and nothing here
 * claims a review reached Google.
 *
 * The rules for what is shown and counted are in review-rules.ts.
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly featureFlags: FeatureFlagService,
    private readonly suppressions: EmailSuppressionService,
    private readonly auditLog: AuditLogService,
    private readonly whatsappTemplates: WhatsAppTemplateService,
  ) {}

  // ───────────────────────── Panel ─────────────────────────

  /**
   * Answered reviews by default. Requests the client has not answered yet
   * (rating 0) only with status=pending: they are not reviews, and mixing
   * them in showed rows of empty stars.
   */
  async listForTenant(
    tenantId: string,
    opts: { rating?: number; professionalId?: string; status?: ReviewStatus; from?: Date; to?: Date } = {},
  ) {
    const reviews = await this.prisma.review.findMany({
      where: {
        tenantId,
        ...(opts.status ? { status: opts.status } : { status: { not: ReviewStatus.pending } }),
        ...(opts.rating ? { rating: opts.rating } : {}),
        ...(opts.professionalId ? { professionalId: opts.professionalId } : {}),
        ...this.dateRange(opts.from, opts.to),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return this.withNames(tenantId, reviews);
  }

  /**
   * The panel's figures. The average follows the same rule as the salon's
   * site: every answered rating except the rejected ones.
   */
  async analytics(tenantId: string, from?: Date, to?: Date) {
    const rows = await this.prisma.review.findMany({
      where: { tenantId, ...this.dateRange(from, to) },
      select: { rating: true, professionalId: true, status: true, googleLinkClickedAt: true, moderationReason: true },
    });
    const answered = rows.filter((r) => r.status !== ReviewStatus.pending && r.rating >= 1 && r.rating <= 5);
    const counted = answered.filter((r) => COUNTED_STATUSES.includes(r.status));
    const total = counted.length;
    const sum = counted.reduce((acc, r) => acc + r.rating, 0);
    const distribution = [0, 0, 0, 0, 0];
    for (const r of counted) distribution[r.rating - 1]++;

    const byProf = new Map<string, { count: number; sum: number }>();
    for (const r of counted) {
      if (!r.professionalId) continue;
      const entry = byProf.get(r.professionalId) ?? { count: 0, sum: 0 };
      entry.count++;
      entry.sum += r.rating;
      byProf.set(r.professionalId, entry);
    }
    const topPerformers = Array.from(byProf.entries())
      .map(([professionalId, v]) => ({
        professionalId,
        averageRating: Number((v.sum / v.count).toFixed(2)),
        count: v.count,
      }))
      .sort((a, b) => b.averageRating - a.averageRating)
      .slice(0, 10);

    return {
      averageRating: total ? Number((sum / total).toFixed(2)) : 0,
      total,
      answered: answered.length,
      rejected: answered.length - total,
      distribution,
      topPerformers,
      requestsSent: rows.length,
      responseRate: rows.length ? Number((answered.length / rows.length).toFixed(2)) : 0,
      pendingModeration: answered.filter((r) => r.status === ReviewStatus.moderation).length,
      // Rejected before a reason was required: the salon should look at them again.
      legacyRejections: answered.filter(
        (r) => r.status === ReviewStatus.rejected && r.moderationReason === LEGACY_REJECTION_REASON,
      ).length,
      googleClicks: answered.filter((r) => r.googleLinkClickedAt).length,
    };
  }

  /**
   * Approve, or reject/hide for one of the listed reasons. Who did it and
   * when is kept on the review and in the audit log. Rejecting an already
   * rejected review changes its reason (that is how a legacy rejection gets
   * one).
   */
  async moderate(
    tenantId: string,
    id: string,
    action: "approve" | "reject",
    reason: string | undefined,
    actor: ReviewModerator,
  ) {
    const r = await this.prisma.review.findFirst({ where: { id, tenantId } });
    if (!r) throw new NotFoundException("Reseña no encontrada");
    if (r.status === ReviewStatus.pending) {
      throw new BadRequestException("La clienta todavía no ha respondido");
    }
    if (action === "reject" && !isRejectionReason(reason)) {
      throw new BadRequestException(
        "Para rechazar u ocultar una reseña elige el motivo: insultos o contenido ofensivo, datos personales, no habla del servicio, o spam o duplicada.",
      );
    }
    const updated = await this.prisma.review.update({
      where: { id },
      data: {
        status: action === "approve" ? ReviewStatus.published : ReviewStatus.rejected,
        moderationReason: action === "approve" ? null : reason,
        moderatedById: actor.id,
        moderatedAt: new Date(),
      },
    });
    await this.auditLog
      .record(action === "approve" ? "review.approved" : "review.rejected", {
        actorId: actor.id,
        actorRole: actor.role as UserRole,
        tenantId,
        metadata: { reviewId: id, rating: r.rating, previousStatus: r.status, reason: action === "reject" ? reason : null },
      })
      .catch((err) => this.logger.warn(`audit log for review ${id} not written: ${err.message}`));
    // Never the link's token: it is the client's only credential.
    const [named] = await this.withNames(tenantId, [updated]);
    return named;
  }

  // ───────────────────────── Settings ─────────────────────────

  async getSettings(tenantId: string) {
    const profile = await this.prisma.googleBusinessProfile.findUnique({ where: { tenantId } });
    const [entitled, whatsapp] = await Promise.all([
      this.automaticRequestsEntitled(tenantId),
      this.whatsappReviewTemplateStatus(tenantId),
    ]);
    return {
      googlePlaceId: profile?.placeId ?? null,
      googleWriteReviewUrl: profile?.writeReviewUrl ?? null,
      googleReviewLink: googleWriteReviewLink(profile),
      autoRequestsEnabled: profile?.enableReviewRequests ?? false,
      addOnActive: entitled,
      // By WhatsApp to clients who asked for their appointment notices by
      // WhatsApp, once Meta approves the salon's review template; by email
      // to everyone else (and when WhatsApp fails). No SMS.
      channels: {
        email: this.emailService.isConfigured(),
        whatsapp,
      },
      // Reading and replying to Google reviews from the panel is not built:
      // it needs Google's approval of the Business Profile API.
      googleApi: { available: false },
      policy: {
        delayHours: REQUEST_DELAY_HOURS,
        windowHours: REQUEST_WINDOW_HOURS,
        clientCooldownDays: CLIENT_COOLDOWN_DAYS,
        tokenTtlDays: TOKEN_TTL_DAYS,
        moderationGraceDays: MODERATION_GRACE_DAYS,
        rejectionReasons: REASON_OPTIONS,
      },
    };
  }

  async updateSettings(
    tenantId: string,
    input: { googlePlaceId?: string | null; googleWriteReviewUrl?: string | null; autoRequestsEnabled?: boolean },
  ) {
    const data: Prisma.GoogleBusinessProfileUncheckedUpdateInput = {};
    if (input.googlePlaceId !== undefined) {
      const placeId = (input.googlePlaceId ?? "").trim();
      if (placeId && !PLACE_ID_RE.test(placeId)) {
        throw new BadRequestException(
          "El Place ID no parece válido: es un código como ChIJN1t_tDeuEmsRUsoyG83frY4.",
        );
      }
      data.placeId = placeId || null;
    }
    if (input.googleWriteReviewUrl !== undefined) {
      const url = (input.googleWriteReviewUrl ?? "").trim();
      if (url && !isGoogleReviewUrl(url)) {
        throw new BadRequestException(
          "El enlace tiene que ser de Google: https://g.page/r/..., https://maps.app.goo.gl/..., https://search.google.com/local/writereview?... o https://www.google.es/maps/...",
        );
      }
      data.writeReviewUrl = url || null;
    }
    if (input.autoRequestsEnabled !== undefined) {
      data.enableReviewRequests = input.autoRequestsEnabled;
    }
    await this.prisma.googleBusinessProfile.upsert({
      where: { tenantId },
      update: data,
      create: { tenantId, ...(data as Prisma.GoogleBusinessProfileUncheckedCreateInput) },
    });
    return this.getSettings(tenantId);
  }

  /**
   * "Enviar plantilla a Meta": submits the WhatsApp review template (a
   * UTILITY template, like the reminder) to the salon's WhatsApp Business
   * account. Meta reviews it, usually within hours; until it is approved
   * every request goes by email.
   */
  async submitWhatsAppTemplate(tenantId: string) {
    if (!(await salonWhatsAppConnected(this.prisma, tenantId))) {
      throw new BadRequestException("Conecta el WhatsApp del salón en Ajustes → WhatsApp antes de enviar la plantilla.");
    }
    const result = await this.whatsappTemplates.submitTemplate(tenantId, REVIEW_REQUEST);
    if ("error" in result) {
      throw new BadRequestException(`Meta no ha aceptado la plantilla: ${result.error}`);
    }
    return this.getSettings(tenantId);
  }

  private async whatsappReviewTemplateStatus(tenantId: string): Promise<WhatsAppReviewChannel> {
    if (!(await salonWhatsAppConnected(this.prisma, tenantId))) return "not_connected";
    try {
      const status = (await this.whatsappTemplates.standardStatus(tenantId)).find((t) => t.name === REVIEW_REQUEST.name);
      return status?.status ?? "NOT_SUBMITTED";
    } catch (err: any) {
      this.logger.warn(`WhatsApp template status for tenant ${tenantId} unavailable: ${err.message}`);
      return "unknown";
    }
  }

  /**
   * The add-on, or a plan that includes the feature. The add-on row is
   * checked by key as well as through its `unlocks`, so a catalogue row that
   * predates the migration giving it unlocks still counts.
   */
  async automaticRequestsEntitled(tenantId: string): Promise<boolean> {
    const { unlocked, ctx } = await this.featureFlags.evaluate(tenantId, REVIEW_ADDON_KEY);
    if (unlocked) return true;
    if (!ctx || ctx.subscriptionStatus === "cancelled" || ctx.subscriptionStatus === "suspended") {
      return false;
    }
    const row = await this.prisma.tenantAddOn.findFirst({
      where: { tenantId, status: "active", addOn: { key: REVIEW_ADDON_KEY } },
      select: { id: true },
    });
    return !!row;
  }

  // ───────────────────────── Public page ─────────────────────────

  async getPublic(token: string) {
    const review = await this.findByToken(token);
    const [tenant, appointment, profile] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: review.tenantId },
        select: { name: true, slug: true, logo: true },
      }),
      review.appointmentId
        ? this.prisma.appointment.findUnique({
            where: { id: review.appointmentId },
            select: {
              scheduledDate: true,
              serviceName: true,
              professional: { select: { firstName: true } },
              service: { select: { name: true } },
            },
          })
        : null,
      this.prisma.googleBusinessProfile.findUnique({ where: { tenantId: review.tenantId } }),
    ]);
    const submitted = review.status !== ReviewStatus.pending;
    if (!submitted && review.reviewTokenExpiresAt && review.reviewTokenExpiresAt < new Date()) {
      throw new GoneException("El enlace ha caducado");
    }
    const serviceName = appointment?.serviceName ?? appointment?.service?.name ?? null;
    return {
      tenant,
      professional: appointment?.professional ?? null,
      service: serviceName ? { name: serviceName } : null,
      visitDate: appointment?.scheduledDate ?? null,
      googleReviewLink: googleWriteReviewLink(profile),
      submitted,
      rating: submitted ? review.rating : null,
      publishConsent: submitted ? review.publishConsent : null,
      consentVersion: PUBLISH_CONSENT_VERSION,
    };
  }

  /**
   * The client's answer. Atomic: the update only matches a request still
   * pending and not expired, so two submits racing (double click, two tabs)
   * store one answer and the other gets the 409.
   */
  async submit(token: string, input: { rating: number; comment?: string; publishConsent?: boolean }) {
    const review = await this.findByToken(token);
    if (review.status !== ReviewStatus.pending) {
      throw new ConflictException("Ya nos enviaste tu opinión. ¡Gracias!");
    }
    const now = new Date();
    if (review.reviewTokenExpiresAt && review.reviewTokenExpiresAt < now) {
      throw new GoneException("El enlace ha caducado");
    }
    const rating = Math.round(input.rating);
    if (!(rating >= 1 && rating <= 5)) throw new BadRequestException("La valoración va de 1 a 5");
    const comment = input.comment?.trim() || null;
    const consent = input.publishConsent === true ? "granted" : "declined";

    // Lands in moderation: nothing a client writes is shown on the salon's
    // booking page until the salon approves it (or MODERATION_GRACE_DAYS
    // pass), and only with her consent.
    const claimed = await this.prisma.review.updateMany({
      where: {
        id: review.id,
        status: ReviewStatus.pending,
        OR: [{ reviewTokenExpiresAt: null }, { reviewTokenExpiresAt: { gte: now } }],
      },
      data: {
        rating,
        comment,
        status: ReviewStatus.moderation,
        submittedAt: now,
        publishConsent: consent,
        publishConsentVersion: PUBLISH_CONSENT_VERSION,
        publishConsentAt: now,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("Ya nos enviaste tu opinión. ¡Gracias!");
    }
    if (review.appointmentId) {
      await this.prisma.appointment
        .update({ where: { id: review.appointmentId }, data: { rating, review: comment } })
        .catch((err) => this.logger.warn(`appointment ${review.appointmentId} rating not copied: ${err.message}`));
    }
    const profile = await this.prisma.googleBusinessProfile.findUnique({ where: { tenantId: review.tenantId } });
    return {
      ok: true,
      rating,
      publishConsent: consent,
      // The same link, the same way, for every rating: offering Google only
      // to happy clients is review gating.
      googleReviewLink: googleWriteReviewLink(profile),
    };
  }

  /** The client opened the salon's Google page from the thank-you screen. */
  async recordGoogleClick(token: string) {
    const review = await this.findByToken(token);
    if (review.status !== ReviewStatus.pending && !review.googleLinkClickedAt) {
      await this.prisma.review.update({ where: { id: review.id }, data: { googleLinkClickedAt: new Date() } });
    }
    return { ok: true };
  }

  /**
   * "Don't ask me again": switches off review requests on every channel for
   * this client, in her notification preferences. Works with an expired
   * link too: refusing an opt-out helps nobody.
   */
  async optOut(token: string) {
    const review = await this.findByToken(token);
    const existing = await this.prisma.notificationPreference.findUnique({
      where: { clientId: review.clientId },
    });
    const prefs = { ...((existing?.preferences as Record<string, unknown>) ?? {}) };
    prefs[NotificationType.REVIEW_REQUEST] = { inApp: false, email: false, sms: false, whatsapp: false };
    await this.prisma.notificationPreference.upsert({
      where: { clientId: review.clientId },
      update: { preferences: prefs as Prisma.InputJsonValue },
      create: {
        tenantId: review.tenantId,
        clientId: review.clientId,
        preferences: prefs as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`Client ${review.clientId} opted out of review requests`);
    return { ok: true };
  }

  /**
   * For the salon's booking page. The average and count cover every
   * answered rating but the rejected ones, anonymously; the list shows only
   * approved reviews whose author agreed to it, with first name and initial.
   */
  async publicForTenant(tenantId: string) {
    const counted = { tenantId, status: { in: COUNTED_STATUSES }, rating: { gte: 1, lte: 5 } };
    const listed = {
      tenantId,
      status: ReviewStatus.published,
      rating: { gte: 1, lte: 5 },
      publishConsent: { in: LISTABLE_CONSENTS },
    };
    const [agg, rows] = await Promise.all([
      this.prisma.review.aggregate({ where: counted, _avg: { rating: true }, _count: { _all: true } }),
      this.prisma.review.findMany({
        where: listed,
        orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
        take: 10,
        select: { id: true, rating: true, comment: true, clientId: true, submittedAt: true, createdAt: true },
      }),
    ]);
    const clients = await this.prisma.client.findMany({
      where: { tenantId, id: { in: rows.map((r) => r.clientId) } },
      select: { id: true, firstName: true, lastName: true },
    });
    const byId = new Map(clients.map((c) => [c.id, c]));
    return {
      averageRating: agg._avg.rating ? Number(agg._avg.rating.toFixed(1)) : 0,
      total: agg._count._all,
      reviews: rows.map((r) => {
        const c = byId.get(r.clientId);
        return {
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          author: c ? `${c.firstName}${c.lastName ? ` ${c.lastName.charAt(0)}.` : ""}` : "Clienta",
          date: r.submittedAt ?? r.createdAt,
        };
      }),
      // What the site lists as the only reasons a review is not published.
      rejectionReasons: REASON_OPTIONS.map((o) => o.label),
    };
  }

  // ───────────────────────── Dispatcher ─────────────────────────

  /**
   * Every hour: publishes reviews left in moderation past the grace period,
   * then, for each salon that switched the requests on and pays for them,
   * asks the clients of recent visits by WhatsApp or email -- only in the
   * salon's sending hours (09:00-21:00 on its clock, any day: a review
   * request is not a campaign).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async dispatchReviewRequests(now: Date = new Date()) {
    await this.publishUnmoderated(now).catch((err) =>
      this.logger.error(`Publishing unmoderated reviews failed: ${err.message}`),
    );
    try {
      const profiles = await this.prisma.googleBusinessProfile.findMany({
        where: { enableReviewRequests: true },
        select: { tenantId: true },
      });
      for (const { tenantId } of profiles) {
        if (!(await this.automaticRequestsEntitled(tenantId))) {
          this.logger.log(`Review requests on for tenant ${tenantId} but the ${REVIEW_ADDON_KEY} add-on is not active: skipped`);
          continue;
        }
        await this.dispatchForTenant(tenantId, now).catch((err) =>
          this.logger.error(`Review requests for tenant ${tenantId} failed: ${err.message}`),
        );
      }
    } catch (err: any) {
      this.logger.error(`Review dispatcher failed: ${err.message}`);
    }
  }

  /**
   * A review the salon neither approved nor rejected within
   * MODERATION_GRACE_DAYS of being sent is published: the salon's site says
   * every review is published unless it breaks the rules, so leaving one in
   * the queue cannot be a way to hide it.
   */
  async publishUnmoderated(now: Date = new Date()) {
    const { count } = await this.prisma.review.updateMany({
      where: {
        status: ReviewStatus.moderation,
        submittedAt: { lte: new Date(now.getTime() - MODERATION_GRACE_DAYS * DAY) },
      },
      data: { status: ReviewStatus.published, moderatedAt: now, moderatedById: null },
    });
    if (count) this.logger.log(`Published ${count} review(s) left unmoderated for ${MODERATION_GRACE_DAYS} days`);
    return count;
  }

  /**
   * The visits to ask about: completed between REQUEST_DELAY_HOURS and
   * REQUEST_WINDOW_HOURS ago, whose scheduled start is in the past and
   * within the window too (an old appointment completed today, or a future
   * one completed by mistake, is not asked about), not asked yet, and with
   * tries left. Nothing is claimed outside the salon's sending hours.
   */
  async dispatchForTenant(tenantId: string, now: Date = new Date()) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    if (!withinSendingHours(now, tenant?.timezone)) {
      this.logger.debug(`Review requests for tenant ${tenantId}: outside the salon's sending hours`);
      return { candidates: 0, sent: 0, outsideHours: true };
    }
    const windowStart = new Date(now.getTime() - REQUEST_WINDOW_HOURS * HOUR);
    const candidates = (await this.prisma.appointment.findMany({
      where: {
        tenantId,
        status: AppointmentStatus.completed,
        reviewRequestSent: false,
        reviewRequestAttempts: { lt: MAX_REQUEST_ATTEMPTS },
        startTime: { lte: now, gte: windowStart },
        completionTime: {
          lte: new Date(now.getTime() - REQUEST_DELAY_HOURS * HOUR),
          gte: windowStart,
        },
      },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        professionalId: true,
        reviewRequestAttempts: true,
        serviceName: true,
        client: {
          select: { id: true, firstName: true, email: true, phone: true, communicationPreferences: true, status: true },
        },
        service: { select: { name: true } },
        tenant: { select: { name: true, country: true } },
      },
      orderBy: { completionTime: "asc" },
      take: 100,
    })) as CandidateAppointment[];

    let sent = 0;
    for (const appt of candidates) {
      // Claim it first: with two backend instances both crons see the same
      // rows, and only the one whose update flips the flag goes on. It
      // matches the attempts it read, so a row given back by a failed try
      // is not taken on a stale read.
      const claimed = await this.prisma.appointment.updateMany({
        where: { id: appt.id, reviewRequestSent: false, reviewRequestAttempts: appt.reviewRequestAttempts },
        data: { reviewRequestSent: true },
      });
      if (claimed.count !== 1) continue;
      let outcome: RequestOutcome;
      try {
        outcome = await this.requestReview(appt, now);
      } catch (err: any) {
        this.logger.error(`Review request for appointment ${appt.id} failed: ${err.message}`);
        outcome = "failed";
      }
      if (outcome === "sent") {
        sent++;
        continue;
      }
      // The flag only stays set when the request went. A failed try is
      // given back for a later tick; one that can never go uses up its
      // tries so it is not looked at again.
      const attempts = outcome === "failed" ? appt.reviewRequestAttempts + 1 : MAX_REQUEST_ATTEMPTS;
      await this.prisma.appointment.update({
        where: { id: appt.id },
        data: { reviewRequestSent: false, reviewRequestAttempts: attempts },
      });
      if (outcome === "failed" && attempts >= MAX_REQUEST_ATTEMPTS) {
        this.logger.warn(`Review request for appointment ${appt.id} failed ${MAX_REQUEST_ATTEMPTS} times: giving up`);
      }
    }
    if (candidates.length) {
      this.logger.log(`Review requests for tenant ${tenantId}: ${sent} sent of ${candidates.length} completed appointments`);
    }
    return { candidates: candidates.length, sent };
  }

  /**
   * One try at asking for a review: by WhatsApp when the client asked for
   * her appointment notices by WhatsApp and the salon's review template is
   * approved by Meta (whatsappRoute); otherwise, or when that send fails,
   * by email, as before. "skipped" when it can never go (blocked client,
   * asked recently, no channel left: no WhatsApp and no email, opted out,
   * address on the salon's suppression list); "failed" when a provider is
   * missing or refused it, which a later tick retries.
   */
  private async requestReview(appt: CandidateAppointment, now: Date): Promise<RequestOutcome> {
    const client = appt.client;
    if (!client || client.status === "blocked") return "skipped";

    const recent = await this.prisma.review.findFirst({
      where: {
        tenantId: appt.tenantId,
        OR: [
          { appointmentId: appt.id },
          { clientId: appt.clientId, createdAt: { gte: new Date(now.getTime() - CLIENT_COOLDOWN_DAYS * DAY) } },
        ],
      },
      select: { id: true },
    });
    if (recent) {
      this.logger.debug(`Appointment ${appt.id}: client asked in the last ${CLIENT_COOLDOWN_DAYS} days, skipped`);
      return "skipped";
    }

    const noWhatsApp = await this.whatsappRoute(appt.tenantId, client);
    const noEmail = await this.cannotEmail(appt.tenantId, client);
    if (noWhatsApp && noEmail) {
      this.logger.log(`Review request for appointment ${appt.id} not sent: whatsapp: ${noWhatsApp}; email: ${noEmail}`);
      return "skipped";
    }
    if (noWhatsApp && !this.emailService.isConfigured()) {
      this.logger.log(
        `Review request for appointment ${appt.id} not sent: email provider not configured (platform console or RESEND_API_KEY)`,
      );
      return "failed";
    }

    // The row exists before anything is sent, so the link works the moment
    // the message arrives; it is removed again if nothing went.
    const token = randomBytes(24).toString("base64url");
    const review = await this.prisma.review.create({
      data: {
        tenantId: appt.tenantId,
        appointmentId: appt.id,
        clientId: appt.clientId,
        professionalId: appt.professionalId,
        rating: 0,
        status: ReviewStatus.pending,
        source: noWhatsApp ? ReviewSource.email_link : ReviewSource.whatsapp_link,
        reviewToken: token,
        reviewTokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_DAYS * DAY),
        // Nothing is shown until she answers and ticks the box.
        publishConsent: "declined",
      },
    });
    const link = `${this.frontendUrl()}/public/r/${token}`;
    const serviceName = appt.serviceName ?? appt.service?.name ?? "tu cita";

    let whatsappFailed = false;
    if (!noWhatsApp) {
      const res = await this.whatsappTemplates
        .sendReviewRequest(appt.tenantId, {
          phone: client.phone!,
          clientName: client.firstName,
          salonName: appt.tenant.name,
          serviceName,
          link,
          country: appt.tenant.country ?? undefined,
        })
        .catch((err: Error) => ({ sent: false, messageId: undefined, reason: err.message }));
      if (res.sent) {
        if (res.messageId) await this.storeMessageId(review.id, res.messageId);
        this.logger.log(`Review request for appointment ${appt.id} sent by WhatsApp`);
        return "sent";
      }
      whatsappFailed = true;
      this.logger.log(`Review request for appointment ${appt.id}: WhatsApp not sent (${res.reason ?? "error"}), trying email`);
    }

    // Email: the client's channel, or the fallback of a WhatsApp send that failed.
    if (noEmail || !this.emailService.isConfigured()) {
      await this.prisma.review.delete({ where: { id: review.id } });
      this.logger.log(
        `Review request for appointment ${appt.id} not sent: email: ${noEmail ?? "provider not configured (platform console or RESEND_API_KEY)"}`,
      );
      // Only reached after a WhatsApp send that failed (no channel at all
      // was skipped above): worth another try on a later tick.
      return "failed";
    }
    if (whatsappFailed) {
      await this.prisma.review.update({ where: { id: review.id }, data: { source: ReviewSource.email_link } });
    }
    const res = await this.emailService.sendReviewRequest({
      to: client.email!,
      clientName: client.firstName,
      serviceName,
      salonName: appt.tenant.name,
      reviewUrl: link,
      optOutUrl: `${link}?baja=1`,
      loyalty: await this.loyaltyLine(appt.tenantId, appt.clientId),
    });
    if (!res.success) {
      await this.prisma.review.delete({ where: { id: review.id } });
      this.logger.log(`Review request for appointment ${appt.id} not sent: email: ${res.error ?? "error"}`);
      // An address already known to bounce will not take it on a retry either.
      return res.skipped && !whatsappFailed ? "skipped" : "failed";
    }
    if (res.id) await this.storeMessageId(review.id, res.id);
    this.logger.log(`Review request for appointment ${appt.id} sent by email`);
    return "sent";
  }

  private async storeMessageId(reviewId: string, messageId: string) {
    await this.prisma.review
      .update({ where: { id: reviewId }, data: { requestMessageId: messageId } })
      .catch((err) => this.logger.warn(`Review ${reviewId}: message id not stored: ${err.message}`));
  }

  /**
   * Why this client is not asked by WhatsApp, or null when she is. She is
   * when she asked for her appointment notices by WhatsApp (the request is
   * on file and the switch is on: client-notices.ts), WhatsApp is not
   * turned off on her file, she did not turn review requests off, and the
   * salon's number is connected with the review template (a UTILITY one,
   * like the reminder) approved by Meta. Never fails: an error is a reason.
   */
  private async whatsappRoute(
    tenantId: string,
    client: NonNullable<CandidateAppointment["client"]>,
  ): Promise<string | null> {
    try {
      if (!client.phone?.trim()) return "no phone";
      if ((client.communicationPreferences as { whatsapp?: unknown } | null)?.whatsapp === false) {
        return "WhatsApp turned off on the client's file";
      }
      const [prefs, request] = await Promise.all([
        this.prisma.notificationPreference.findUnique({ where: { clientId: client.id }, select: { preferences: true } }),
        this.prisma.consent.findFirst({
          where: { tenantId, clientId: client.id, revokedAt: null, form: { purpose: WHATSAPP_NOTICES_PURPOSE } },
          orderBy: { signedAt: "desc" },
          select: { responses: true },
        }),
      ]);
      const granted = (request?.responses as Record<string, unknown> | null)?.[MARKETING_FIELD_ID] === true;
      if (!granted || !noticeChannelsOf(prefs?.preferences).whatsapp) {
        return "no WhatsApp appointment notices";
      }
      const stored = (prefs?.preferences ?? {}) as Record<string, Record<string, unknown> | undefined>;
      if (stored[NotificationType.REVIEW_REQUEST]?.whatsapp === false) return "the client turned review requests off";
      const check = await this.whatsappTemplates.canSend(tenantId, REVIEW_REQUEST);
      return check.ok ? null : check.reason ?? "template not approved";
    } catch (err) {
      return `check failed: ${(err as Error).message}`;
    }
  }

  /**
   * Her points, for an optional line of the email: only when the salon's
   * programme is on with "Mostrar puntos en el email tras la visita" (on by
   * default) and she is a member with points (reviewEmailPoints). A failed
   * read never stops the request.
   */
  private async loyaltyLine(tenantId: string, clientId: string | null) {
    return reviewEmailPoints(this.prisma as any, tenantId, clientId, (t) =>
      this.featureFlags.isFeatureUnlocked(t, "loyalty"),
    ).catch((err: Error) => {
      this.logger.warn(`Review request: loyalty line not read: ${err.message}`);
      return null;
    });
  }

  /**
   * Why this client cannot be emailed a review request, or null. Her own
   * "no more review requests" and the salon's suppression list (hard
   * bounce, complaint, unsubscribe link) both stop it. Refusing promotions
   * ("No quiero recibir promociones") does not: a review request is about
   * her visit, not an offer.
   */
  private async cannotEmail(
    tenantId: string,
    client: NonNullable<CandidateAppointment["client"]>,
  ): Promise<string | null> {
    if (!client.email) return "no email";
    const ok = await this.notificationsService.shouldSendNotification(client.id, NotificationType.REVIEW_REQUEST, "email");
    if (!ok) return "the client turned review requests off";
    const suppressed = await this.suppressions.suppressedAmong(tenantId, [client.email]);
    if (suppressed.has(client.email.toLowerCase())) return "address on the salon's suppression list";
    return null;
  }

  // ───────────────────────── Helpers ─────────────────────────

  private async findByToken(token: string) {
    if (!token || !TOKEN_RE.test(token)) throw new NotFoundException("Enlace no válido");
    const review = await this.prisma.review.findUnique({ where: { reviewToken: token } });
    if (!review) throw new NotFoundException("Enlace no válido");
    return review;
  }

  private async withNames<
    T extends {
      clientId: string;
      professionalId: string | null;
      appointmentId: string | null;
      moderatedById?: string | null;
      moderationReason?: string | null;
      reviewToken?: string | null;
      requestMessageId?: string | null;
    },
  >(tenantId: string, reviews: T[]) {
    if (!reviews.length) return [];
    const moderatorIds = [...new Set(reviews.map((r) => r.moderatedById).filter(Boolean) as string[])];
    const [clients, professionals, appointments, moderators] = await Promise.all([
      this.prisma.client.findMany({
        where: { tenantId, id: { in: [...new Set(reviews.map((r) => r.clientId))] } },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.prisma.professional.findMany({
        where: { tenantId, id: { in: [...new Set(reviews.map((r) => r.professionalId).filter(Boolean) as string[])] } },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.prisma.appointment.findMany({
        where: { tenantId, id: { in: reviews.map((r) => r.appointmentId).filter(Boolean) as string[] } },
        select: { id: true, serviceName: true, service: { select: { name: true } } },
      }),
      moderatorIds.length
        ? this.prisma.user.findMany({
            where: { tenantId, id: { in: moderatorIds } },
            select: { id: true, firstName: true, lastName: true },
          })
        : Promise.resolve([] as Array<{ id: string; firstName: string; lastName: string | null }>),
    ]);
    const full = (x: { firstName: string; lastName: string | null }) => `${x.firstName} ${x.lastName ?? ""}`.trim();
    const c = new Map(clients.map((x) => [x.id, full(x)]));
    const p = new Map(professionals.map((x) => [x.id, full(x)]));
    const a = new Map(appointments.map((x) => [x.id, x.serviceName ?? x.service?.name ?? null]));
    const m = new Map(moderators.map((x) => [x.id, full(x)]));
    return reviews.map((r) => {
      // Never the link's token (the client's credential) nor the provider's id.
      const { reviewToken: _token, requestMessageId: _messageId, ...rest } = r;
      return {
        ...rest,
        clientName: c.get(r.clientId) ?? null,
        professionalName: r.professionalId ? p.get(r.professionalId) ?? null : null,
        serviceName: r.appointmentId ? a.get(r.appointmentId) ?? null : null,
        moderatedByName: r.moderatedById ? m.get(r.moderatedById) ?? null : null,
        moderationReasonLabel: r.moderationReason
          ? REJECTION_REASON_LABEL[r.moderationReason as keyof typeof REJECTION_REASON_LABEL] ?? r.moderationReason
          : null,
      };
    });
  }

  private dateRange(from?: Date, to?: Date) {
    if (!from && !to) return {};
    return { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } };
  }

  private frontendUrl(): string {
    const base =
      this.config.get<string>("FRONTEND_URL") ||
      this.config.get<string>("APP_BASE_URL") ||
      "http://localhost:3000";
    return base.replace(/\/+$/, "");
  }
}
