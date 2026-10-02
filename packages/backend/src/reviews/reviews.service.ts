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
import { AppointmentStatus, Prisma, ReviewSource, ReviewStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationType } from "../notifications/dto";
import { EmailService } from "../notifications/services/email.service";
import { SmsService } from "../notifications/services/sms.service";
import { WhatsAppTemplateService } from "../whatsapp/whatsapp-template.service";
import { REVIEW_REQUEST } from "../whatsapp/whatsapp-templates";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";

/** The add-on that pays for automatic review requests. */
export const REVIEW_ADDON_KEY = "google_reviews_auto" as const;
/** Hours after the appointment is completed before asking: the client is home, not at the till. */
export const REQUEST_DELAY_HOURS = 2;
/**
 * Visits older than this are never chased. Without it, a salon switching the
 * requests on would email every client it ever served.
 */
export const REQUEST_WINDOW_HOURS = 72;
/** A regular client is asked at most once in this many days, however often she comes. */
export const CLIENT_COOLDOWN_DAYS = 30;
export const TOKEN_TTL_DAYS = 14;
/** From this rating up the thank-you screen puts the Google button first. */
export const GOOD_RATING = 4;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

/**
 * Google's "write a review" link for a Place ID. Needs no API access: it is
 * the link Google itself gives a business owner to share.
 */
export function googleWriteReviewLink(profile: {
  placeId?: string | null;
  writeReviewUrl?: string | null;
} | null): string | null {
  if (!profile) return null;
  if (profile.placeId) {
    return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(profile.placeId)}`;
  }
  return profile.writeReviewUrl || null;
}

/**
 * Only https links on Google's own hosts. The link is shown to the salon's
 * clients on a KiraRoom page as "your Google review page", so it must not be
 * able to point anywhere else.
 */
export function isGoogleReviewUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "g.page" ||
    host === "maps.app.goo.gl" ||
    host === "goo.gl" ||
    host === "g.co" ||
    /^([a-z0-9-]+\.)*google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)
  );
}

type Channel = "email" | "whatsapp" | "sms";

interface CandidateAppointment {
  id: string;
  tenantId: string;
  clientId: string;
  professionalId: string | null;
  client: {
    id: string;
    firstName: string;
    email: string | null;
    phone: string | null;
    status: string;
  } | null;
  service: { name: string } | null;
  tenant: { name: string; country: string | null };
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
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly whatsappTemplates: WhatsAppTemplateService,
    private readonly featureFlags: FeatureFlagService,
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

  async analytics(tenantId: string, from?: Date, to?: Date) {
    const rows = await this.prisma.review.findMany({
      where: { tenantId, ...this.dateRange(from, to) },
      select: { rating: true, professionalId: true, status: true, googleLinkClickedAt: true },
    });
    const answered = rows.filter((r) => r.status !== ReviewStatus.pending && r.rating >= 1 && r.rating <= 5);
    const total = answered.length;
    const sum = answered.reduce((acc, r) => acc + r.rating, 0);
    const distribution = [0, 0, 0, 0, 0];
    for (const r of answered) distribution[r.rating - 1]++;

    const byProf = new Map<string, { count: number; sum: number }>();
    for (const r of answered) {
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
      distribution,
      topPerformers,
      requestsSent: rows.length,
      responseRate: rows.length ? Number((total / rows.length).toFixed(2)) : 0,
      pendingModeration: answered.filter((r) => r.status === ReviewStatus.moderation).length,
      googleClicks: answered.filter((r) => r.googleLinkClickedAt).length,
    };
  }

  async moderate(tenantId: string, id: string, action: "approve" | "reject") {
    const r = await this.prisma.review.findFirst({ where: { id, tenantId } });
    if (!r) throw new NotFoundException("Reseña no encontrada");
    if (r.status === ReviewStatus.pending) {
      throw new BadRequestException("La clienta todavía no ha respondido");
    }
    return this.prisma.review.update({
      where: { id },
      data: { status: action === "approve" ? ReviewStatus.published : ReviewStatus.rejected },
    });
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
      channels: {
        email: this.emailService.isConfigured(),
        sms: this.smsService.isConfigured(),
        whatsapp,
      },
      // Reading and replying to Google reviews from the panel is not built:
      // it needs Google's approval of the Business Profile API.
      googleApi: { available: false },
      policy: {
        delayHours: REQUEST_DELAY_HOURS,
        clientCooldownDays: CLIENT_COOLDOWN_DAYS,
        tokenTtlDays: TOKEN_TTL_DAYS,
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
          "El enlace tiene que ser de Google (https://g.page/r/..., https://search.google.com/local/writereview?... o similar).",
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
    return {
      tenant,
      professional: appointment?.professional ?? null,
      service: appointment?.service ?? null,
      visitDate: appointment?.scheduledDate ?? null,
      googleReviewLink: googleWriteReviewLink(profile),
      submitted,
      rating: submitted ? review.rating : null,
      goodRating: GOOD_RATING,
    };
  }

  async submit(token: string, input: { rating: number; comment?: string }) {
    const review = await this.findByToken(token);
    if (review.status !== ReviewStatus.pending) {
      throw new ConflictException("Ya nos enviaste tu opinión. ¡Gracias!");
    }
    if (review.reviewTokenExpiresAt && review.reviewTokenExpiresAt < new Date()) {
      throw new GoneException("El enlace ha caducado");
    }
    const rating = Math.round(input.rating);
    if (!(rating >= 1 && rating <= 5)) throw new BadRequestException("La valoración va de 1 a 5");
    const comment = input.comment?.trim() || null;

    // Lands in moderation: nothing a client writes is shown on the salon's
    // booking page until the salon approves it.
    const updated = await this.prisma.review.update({
      where: { id: review.id },
      data: { rating, comment, status: ReviewStatus.moderation, submittedAt: new Date() },
    });
    if (review.appointmentId) {
      await this.prisma.appointment
        .update({ where: { id: review.appointmentId }, data: { rating, review: comment } })
        .catch((err) => this.logger.warn(`appointment ${review.appointmentId} rating not copied: ${err.message}`));
    }
    const profile = await this.prisma.googleBusinessProfile.findUnique({ where: { tenantId: review.tenantId } });
    return {
      ok: true,
      rating: updated.rating,
      googleReviewLink: googleWriteReviewLink(profile),
      goodRating: GOOD_RATING,
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
   * this client, in the same preferences the client account page edits.
   * Works with an expired link too: refusing an opt-out helps nobody.
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

  /** Approved reviews for the salon's booking page: first name and initial only. */
  async publicForTenant(tenantId: string) {
    const where = { tenantId, status: ReviewStatus.published, rating: { gte: 1 } };
    const [agg, rows] = await Promise.all([
      this.prisma.review.aggregate({ where, _avg: { rating: true }, _count: { _all: true } }),
      this.prisma.review.findMany({
        where,
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
    };
  }

  // ───────────────────────── Dispatcher ─────────────────────────

  /**
   * Every hour: for each salon that switched the requests on and pays for
   * them, ask the clients of appointments completed between 2 and 72 hours
   * ago. Through the first channel that works and the client accepts:
   * email, then the salon's WhatsApp (approved template), then SMS. With no
   * provider configured nothing is sent, the reason is logged, and no
   * request is recorded.
   *
   * This replaces two jobs that raced each other: one created an in-app
   * notice with a link to a page that does not exist (/r/...), the other an
   * English email whose button pointed at "#".
   */
  @Cron(CronExpression.EVERY_HOUR)
  async dispatchReviewRequests(now: Date = new Date()) {
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

  async dispatchForTenant(tenantId: string, now: Date = new Date()) {
    const candidates = (await this.prisma.appointment.findMany({
      where: {
        tenantId,
        status: AppointmentStatus.completed,
        reviewRequestSent: false,
        completionTime: {
          lte: new Date(now.getTime() - REQUEST_DELAY_HOURS * HOUR),
          gte: new Date(now.getTime() - REQUEST_WINDOW_HOURS * HOUR),
        },
      },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        professionalId: true,
        client: { select: { id: true, firstName: true, email: true, phone: true, status: true } },
        service: { select: { name: true } },
        tenant: { select: { name: true, country: true } },
      },
      take: 100,
    })) as CandidateAppointment[];

    let sent = 0;
    for (const appt of candidates) {
      // Claim it first: with two backend instances both crons see the same
      // rows, and only the one whose update flips the flag goes on.
      const claimed = await this.prisma.appointment.updateMany({
        where: { id: appt.id, reviewRequestSent: false },
        data: { reviewRequestSent: true },
      });
      if (claimed.count !== 1) continue;
      try {
        if (await this.requestReview(appt, now)) sent++;
      } catch (err: any) {
        this.logger.error(`Review request for appointment ${appt.id} failed: ${err.message}`);
      }
    }
    if (candidates.length) {
      this.logger.log(`Review requests for tenant ${tenantId}: ${sent} sent of ${candidates.length} completed appointments`);
    }
    return { candidates: candidates.length, sent };
  }

  /** Returns true when the request reached the client on some channel. */
  private async requestReview(appt: CandidateAppointment, now: Date): Promise<boolean> {
    const client = appt.client;
    if (!client || client.status === "blocked") return false;

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
      return false;
    }

    // The row exists before anything is sent, so the link works the moment
    // the message arrives; it is removed again if no channel delivered it.
    const token = randomBytes(24).toString("base64url");
    const review = await this.prisma.review.create({
      data: {
        tenantId: appt.tenantId,
        appointmentId: appt.id,
        clientId: appt.clientId,
        professionalId: appt.professionalId,
        rating: 0,
        status: ReviewStatus.pending,
        source: ReviewSource.email_link,
        reviewToken: token,
        reviewTokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_DAYS * DAY),
      },
    });

    const link = `${this.frontendUrl()}/public/r/${token}`;
    const serviceName = appt.service?.name ?? "tu cita";
    const reasons: string[] = [];
    let channel: Channel | null = null;

    if (await this.allowed(client, "email", reasons)) {
      if (!this.emailService.isConfigured()) {
        reasons.push("email: proveedor no configurado (RESEND_API_KEY)");
      } else {
        const res = await this.emailService.sendReviewRequest({
          to: client.email!,
          clientName: client.firstName,
          serviceName,
          salonName: appt.tenant.name,
          reviewUrl: link,
          optOutUrl: `${link}?baja=1`,
        });
        if (res.success) channel = "email";
        else reasons.push(`email: ${res.error ?? "error"}`);
      }
    }

    if (!channel && (await this.allowed(client, "whatsapp", reasons))) {
      const res = await this.whatsappTemplates.sendReviewRequest(appt.tenantId, {
        phone: client.phone!,
        clientName: client.firstName,
        salonName: appt.tenant.name,
        serviceName,
        link,
        country: appt.tenant.country ?? undefined,
      });
      if (res.sent) channel = "whatsapp";
      else reasons.push(`whatsapp: ${res.reason}`);
    }

    if (!channel && (await this.allowed(client, "sms", reasons))) {
      if (!this.smsService.isConfigured()) {
        reasons.push("sms: proveedor no configurado (Twilio)");
      } else {
        const res = await this.smsService.sendSms({
          to: client.phone!,
          body: `Hola ${client.firstName}, gracias por tu visita a ${appt.tenant.name}. ¿Qué tal fue? Valóralo aquí: ${link}`,
        });
        if (res.success) channel = "sms";
        else reasons.push(`sms: ${res.error ?? "error"}`);
      }
    }

    if (!channel) {
      await this.prisma.review.delete({ where: { id: review.id } });
      this.logger.log(`Review request for appointment ${appt.id} not sent: ${reasons.join("; ") || "no channel"}`);
      return false;
    }

    const source =
      channel === "email" ? ReviewSource.email_link : channel === "sms" ? ReviewSource.sms_link : ReviewSource.whatsapp_link;
    if (source !== ReviewSource.email_link) {
      await this.prisma.review.update({ where: { id: review.id }, data: { source } });
    }

    // Also in the client's account, for those who have one.
    if (await this.notificationsService.shouldSendNotification(client.id, NotificationType.REVIEW_REQUEST, "inApp")) {
      await this.notificationsService
        .create({
          tenantId: appt.tenantId,
          clientId: client.id,
          type: NotificationType.REVIEW_REQUEST,
          title: "¿Qué tal tu visita?",
          message: `Cuéntanos qué tal fue en ${appt.tenant.name}.`,
          data: { appointmentId: appt.id, link },
        })
        .catch((err) => this.logger.warn(`In-app review notice skipped: ${err.message}`));
    }
    this.logger.log(`Review request for appointment ${appt.id} sent by ${channel}`);
    return true;
  }

  /** The client has the contact detail for the channel and has not turned it off. */
  private async allowed(client: NonNullable<CandidateAppointment["client"]>, channel: Channel, reasons: string[]) {
    const contact = channel === "email" ? client.email : client.phone;
    if (!contact) return false;
    const ok = await this.notificationsService.shouldSendNotification(client.id, NotificationType.REVIEW_REQUEST, channel);
    if (!ok) reasons.push(`${channel}: la clienta no lo acepta`);
    return ok;
  }

  // ───────────────────────── Helpers ─────────────────────────

  private async findByToken(token: string) {
    if (!token || !TOKEN_RE.test(token)) throw new NotFoundException("Enlace no válido");
    const review = await this.prisma.review.findUnique({ where: { reviewToken: token } });
    if (!review) throw new NotFoundException("Enlace no válido");
    return review;
  }

  private async whatsappReviewTemplateStatus(tenantId: string): Promise<string> {
    const conn = await this.prisma.whatsAppConnection.findUnique({
      where: { tenantId },
      select: { isActive: true },
    });
    if (!conn?.isActive) return "not_connected";
    try {
      const status = (await this.whatsappTemplates.standardStatus(tenantId)).find(
        (t) => t.name === REVIEW_REQUEST.name,
      );
      return status?.status ?? "NOT_SUBMITTED";
    } catch (err: any) {
      this.logger.warn(`WhatsApp template status for tenant ${tenantId} unavailable: ${err.message}`);
      return "unknown";
    }
  }

  private async withNames<T extends { clientId: string; professionalId: string | null; appointmentId: string | null }>(
    tenantId: string,
    reviews: T[],
  ) {
    if (!reviews.length) return [];
    const [clients, professionals, appointments] = await Promise.all([
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
        select: { id: true, service: { select: { name: true } } },
      }),
    ]);
    const c = new Map(clients.map((x) => [x.id, `${x.firstName} ${x.lastName ?? ""}`.trim()]));
    const p = new Map(professionals.map((x) => [x.id, `${x.firstName} ${x.lastName ?? ""}`.trim()]));
    const a = new Map(appointments.map((x) => [x.id, x.service?.name ?? null]));
    return reviews.map((r) => ({
      ...r,
      reviewToken: undefined,
      clientName: c.get(r.clientId) ?? null,
      professionalName: r.professionalId ? p.get(r.professionalId) ?? null : null,
      serviceName: r.appointmentId ? a.get(r.appointmentId) ?? null : null,
    }));
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
