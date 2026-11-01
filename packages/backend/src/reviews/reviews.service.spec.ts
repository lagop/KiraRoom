import { BadRequestException, ConflictException, GoneException, NotFoundException } from "@nestjs/common";
import { ReviewSource, ReviewStatus } from "@prisma/client";
import {
  CLIENT_COOLDOWN_DAYS,
  MAX_REQUEST_ATTEMPTS,
  ReviewsService,
  googleWriteReviewLink,
  isGoogleReviewUrl,
} from "./reviews.service";
import { MODERATION_GRACE_DAYS, PUBLISH_CONSENT_VERSION } from "./review-rules";

/**
 * The real review flow: one request per recent visit, by email, in the
 * salon's sending hours, never to an address that bounced, complained or
 * unsubscribed; a failed send retried, a request that can never go not
 * looked at again; the answer stored atomically with the client's publish
 * consent; rejection only for a listed reason, with who and when; and the
 * same Google link whatever the rating.
 */

// 12:00 UTC = 14:00 in Madrid: inside the sending hours.
const NOW = new Date("2026-10-02T12:00:00.000Z");
const HOUR = 3600_000;

function appointment(over: Partial<any> = {}) {
  return {
    id: "appt-1",
    tenantId: "t1",
    clientId: "c1",
    professionalId: "p1",
    reviewRequestAttempts: 0,
    serviceName: "Corte",
    client: { id: "c1", firstName: "Ana", email: "Ana@Example.test", status: "active" },
    service: { name: "Corte (catálogo)" },
    tenant: { name: "Salón Lucía" },
    ...over,
  };
}

function setup(over: {
  candidates?: any[];
  claimed?: number;
  recent?: any;
  prefs?: Record<string, boolean>;
  emailConfigured?: boolean;
  emailResult?: any;
  suppressed?: string[];
  entitled?: boolean;
  addOnRow?: any;
  review?: any;
  profile?: any;
  existingPrefs?: any;
  submitCount?: number;
  timezone?: string;
} = {}) {
  const prisma: any = {
    appointment: {
      findMany: jest.fn(async () => over.candidates ?? [appointment()]),
      updateMany: jest.fn(async () => ({ count: over.claimed ?? 1 })),
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => null),
    },
    review: {
      findFirst: jest.fn(async () => over.recent ?? null),
      findUnique: jest.fn(async () => over.review ?? null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ id: "rev-1", ...data })),
      update: jest.fn(async ({ data }: any) => ({
        id: "rev-1",
        clientId: "c1",
        professionalId: null,
        appointmentId: null,
        ...(over.review ?? {}),
        ...data,
      })),
      updateMany: jest.fn(async () => ({ count: over.submitCount ?? 1 })),
      delete: jest.fn(async () => ({})),
      aggregate: jest.fn(),
    },
    googleBusinessProfile: {
      findMany: jest.fn(async () => [{ tenantId: "t1" }]),
      findUnique: jest.fn(async () => over.profile ?? null),
      upsert: jest.fn(async () => ({})),
    },
    tenantAddOn: { findFirst: jest.fn(async () => over.addOnRow ?? null) },
    tenant: {
      findUnique: jest.fn(async () => ({
        name: "Salón Lucía",
        slug: "lucia",
        logo: null,
        timezone: over.timezone ?? "Europe/Madrid",
      })),
    },
    notificationPreference: {
      findUnique: jest.fn(async () => over.existingPrefs ?? null),
      upsert: jest.fn(async () => ({})),
    },
    client: { findMany: jest.fn(async () => []) },
    professional: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => [{ id: "u1", firstName: "Lucía", lastName: "Pérez" }]) },
  };
  const config: any = { get: jest.fn((k: string) => (k === "FRONTEND_URL" ? "https://app.example.test/" : undefined)) };
  const prefs = { email: true, whatsapp: false, sms: false, inApp: true, ...(over.prefs ?? {}) };
  const notifications: any = {
    shouldSendNotification: jest.fn(async (_c: string, _t: string, ch: keyof typeof prefs) => prefs[ch]),
    create: jest.fn(async () => ({})),
  };
  const email: any = {
    isConfigured: jest.fn(() => over.emailConfigured ?? true),
    sendReviewRequest: jest.fn(async () => over.emailResult ?? { success: true, id: "em1" }),
  };
  const flags: any = {
    evaluate: jest.fn(async () => ({
      unlocked: over.entitled ?? true,
      ctx: { subscriptionStatus: "active" },
    })),
  };
  const suppressions: any = {
    suppressedAmong: jest.fn(async () => new Set(over.suppressed ?? [])),
  };
  const auditLog: any = { record: jest.fn(async () => ({ id: "a1" })) };
  const service = new ReviewsService(prisma, config, notifications, email, flags, suppressions, auditLog);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { service, prisma, notifications, email, flags, suppressions, auditLog };
}

describe("Google review link", () => {
  it("is built from the Place ID, which wins over a pasted URL", () => {
    expect(googleWriteReviewLink({ placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4", writeReviewUrl: "https://g.page/r/x/review" })).toBe(
      "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4",
    );
    expect(googleWriteReviewLink({ placeId: null, writeReviewUrl: "https://g.page/r/x/review" })).toBe(
      "https://g.page/r/x/review",
    );
    expect(googleWriteReviewLink(null)).toBeNull();
  });

  it("does not hand out a saved link that is no longer on the list", () => {
    expect(googleWriteReviewLink({ placeId: null, writeReviewUrl: "https://g.co/kgs/abc" })).toBeNull();
  });

  it("accepts only https links to where Google takes reviews", () => {
    for (const ok of [
      "https://g.page/r/CabcDEF/review",
      "https://maps.app.goo.gl/abc",
      "https://search.google.com/local/writereview?placeid=abc",
      "https://www.google.es/maps/place/x",
      "https://www.google.com/maps?cid=123",
      "https://www.google.co.uk/maps/place/x",
    ]) {
      expect(isGoogleReviewUrl(ok)).toBe(true);
    }
    for (const bad of [
      "http://g.page/r/x",
      "https://google.com.evil.test/x",
      "https://evil.test/?google.com",
      "javascript:alert(1)",
      "https://goo.gl/abc",
      "https://g.co/kgs/abc",
      "https://docs.google.com/forms/d/x",
      "https://www.google.com/url?q=https://evil.test",
      "https://search.google.com/search?q=x",
      "https://sites.google.com/view/x",
      "https://www.google.es/search?q=maps",
      "https://user@g.page/r/x",
    ]) {
      expect(isGoogleReviewUrl(bad)).toBe(false);
    }
  });
});

describe("ReviewsService settings", () => {
  it("refuses a Place ID or URL that is not one", async () => {
    const { service } = setup();
    await expect(service.updateSettings("t1", { googlePlaceId: "no es un id!" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateSettings("t1", { googleWriteReviewUrl: "https://evil.test/r" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("stores them, and an empty value clears", async () => {
    const { service, prisma } = setup();
    await service.updateSettings("t1", { googlePlaceId: " ChIJN1t_tDeuEmsRUsoyG83frY4 ", autoRequestsEnabled: true });
    expect(prisma.googleBusinessProfile.upsert.mock.calls[0][0].update).toEqual({
      placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
      enableReviewRequests: true,
    });
    await service.updateSettings("t1", { googleWriteReviewUrl: "" });
    expect(prisma.googleBusinessProfile.upsert.mock.calls[1][0].update).toEqual({ writeReviewUrl: null });
  });

  it("says plainly that the Google API is not available, and offers email only", async () => {
    const { service } = setup();
    const s = await service.getSettings("t1");
    expect(s.googleApi.available).toBe(false);
    expect(s.channels).toEqual({ email: true });
    expect(s.policy.rejectionReasons.map((r) => r.key)).toEqual(["offensive", "personal_data", "off_topic", "spam"]);
  });
});

describe("ReviewsService.dispatchForTenant", () => {
  it("emails the client a working link, records the request and the message id", async () => {
    const { service, prisma, email } = setup();
    const out = await service.dispatchForTenant("t1", NOW);
    expect(out).toEqual({ candidates: 1, sent: 1 });

    const created = prisma.review.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      tenantId: "t1",
      appointmentId: "appt-1",
      status: ReviewStatus.pending,
      rating: 0,
      source: ReviewSource.email_link,
      publishConsent: "declined",
    });
    const args = email.sendReviewRequest.mock.calls[0][0];
    expect(args.reviewUrl).toBe(`https://app.example.test/public/r/${created.reviewToken}`);
    expect(args.optOutUrl).toBe(`${args.reviewUrl}?baja=1`);
    // The service as booked.
    expect(args.serviceName).toBe("Corte");
    expect(prisma.review.update).toHaveBeenCalledWith({ where: { id: "rev-1" }, data: { requestMessageId: "em1" } });
    expect(prisma.review.delete).not.toHaveBeenCalled();
    // Claimed, and left claimed: it went.
    expect(prisma.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: "appt-1", reviewRequestSent: false, reviewRequestAttempts: 0 },
      data: { reviewRequestSent: true },
    });
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("only visits that started in the last 72 hours and were completed 2 to 72 hours ago", async () => {
    const { service, prisma } = setup();
    await service.dispatchForTenant("t1", NOW);
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.startTime).toEqual({ lte: NOW, gte: new Date(NOW.getTime() - 72 * HOUR) });
    expect(where.completionTime.lte).toEqual(new Date(NOW.getTime() - 2 * HOUR));
    expect(where.completionTime.gte).toEqual(new Date(NOW.getTime() - 72 * HOUR));
    expect(where.reviewRequestSent).toBe(false);
    expect(where.reviewRequestAttempts).toEqual({ lt: MAX_REQUEST_ATTEMPTS });
  });

  it("sends nothing and claims nothing outside 9:00-21:00 on the salon's clock", async () => {
    // 21:30 in Madrid (19:30 UTC in October, CEST).
    const late = new Date("2026-10-02T19:30:00.000Z");
    const { service, prisma, email } = setup();
    expect(await service.dispatchForTenant("t1", late)).toMatchObject({ sent: 0, outsideHours: true });
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
    expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
    expect(email.sendReviewRequest).not.toHaveBeenCalled();
    // Same instant, a salon in the Canaries (20:30): still sending.
    const canary = setup({ timezone: "Atlantic/Canary" });
    expect((await canary.service.dispatchForTenant("t1", late)).sent).toBe(1);
  });

  it("a failed send is given back for a later tick, counting the attempt", async () => {
    const { service, prisma } = setup({ emailResult: { success: false, error: "provider down" } });
    expect((await service.dispatchForTenant("t1", NOW)).sent).toBe(0);
    expect(prisma.review.delete).toHaveBeenCalledWith({ where: { id: "rev-1" } });
    expect(prisma.appointment.update).toHaveBeenCalledWith({
      where: { id: "appt-1" },
      data: { reviewRequestSent: false, reviewRequestAttempts: 1 },
    });
  });

  it("gives up after the last attempt", async () => {
    const { service, prisma } = setup({
      candidates: [appointment({ reviewRequestAttempts: MAX_REQUEST_ATTEMPTS - 1 })],
      emailResult: { success: false, error: "provider down" },
    });
    await service.dispatchForTenant("t1", NOW);
    expect(prisma.appointment.update.mock.calls[0][0].data).toEqual({
      reviewRequestSent: false,
      reviewRequestAttempts: MAX_REQUEST_ATTEMPTS,
    });
    expect((service as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining("giving up"));
  });

  it("with no email provider it records nothing, logs why and retries later", async () => {
    const { service, prisma, email } = setup({ emailConfigured: false });
    const out = await service.dispatchForTenant("t1", NOW);
    expect(out.sent).toBe(0);
    expect(email.sendReviewRequest).not.toHaveBeenCalled();
    expect(prisma.review.create).not.toHaveBeenCalled();
    expect((service as any).logger.log).toHaveBeenCalledWith(expect.stringContaining("RESEND_API_KEY"));
    expect(prisma.appointment.update.mock.calls[0][0].data).toEqual({ reviewRequestSent: false, reviewRequestAttempts: 1 });
  });

  it("never emails an address on the salon's suppression list (bounce, complaint, unsubscribe)", async () => {
    const { service, prisma, email, suppressions } = setup({ suppressed: ["ana@example.test"] });
    expect((await service.dispatchForTenant("t1", NOW)).sent).toBe(0);
    expect(suppressions.suppressedAmong).toHaveBeenCalledWith("t1", ["Ana@Example.test"]);
    expect(email.sendReviewRequest).not.toHaveBeenCalled();
    expect(prisma.review.create).not.toHaveBeenCalled();
    // Can never go: not marked sent, not looked at again.
    expect(prisma.appointment.update.mock.calls[0][0].data).toEqual({
      reviewRequestSent: false,
      reviewRequestAttempts: MAX_REQUEST_ATTEMPTS,
    });
  });

  it("asks a client who only refused promotions, but not one who turned review requests off", async () => {
    const { service, notifications } = setup();
    expect((await service.dispatchForTenant("t1", NOW)).sent).toBe(1);
    // Only the review-request preference is read, not marketing consent.
    expect(notifications.shouldSendNotification).toHaveBeenCalledWith("c1", "review_request", "email");
    const off = setup({ prefs: { email: false } });
    expect((await off.service.dispatchForTenant("t1", NOW)).sent).toBe(0);
    expect(off.email.sendReviewRequest).not.toHaveBeenCalled();
  });

  it("never creates in-app notifications for clients, nor uses WhatsApp or SMS", async () => {
    const { service, notifications } = setup({ prefs: { email: false, whatsapp: true, sms: true, inApp: true } });
    await service.dispatchForTenant("t1", NOW);
    expect(notifications.create).not.toHaveBeenCalled();
    const ok = setup();
    await ok.service.dispatchForTenant("t1", NOW);
    expect(ok.notifications.create).not.toHaveBeenCalled();
  });

  it(`asks a regular client at most once every ${CLIENT_COOLDOWN_DAYS} days`, async () => {
    const { service, prisma, email } = setup({ recent: { id: "old" } });
    expect((await service.dispatchForTenant("t1", NOW)).sent).toBe(0);
    expect(prisma.review.create).not.toHaveBeenCalled();
    expect(email.sendReviewRequest).not.toHaveBeenCalled();
  });

  it("leaves an appointment another instance already claimed", async () => {
    const { service, prisma, email } = setup({ claimed: 0 });
    await service.dispatchForTenant("t1", NOW);
    expect(prisma.review.create).not.toHaveBeenCalled();
    expect(email.sendReviewRequest).not.toHaveBeenCalled();
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("does not ask a blocked client", async () => {
    const { service, email } = setup({
      candidates: [appointment({ client: { id: "c1", firstName: "Ana", email: "a@x.test", status: "blocked" } })],
    });
    await service.dispatchForTenant("t1", NOW);
    expect(email.sendReviewRequest).not.toHaveBeenCalled();
  });
});

describe("ReviewsService.dispatchReviewRequests", () => {
  it("only runs for salons with the add-on active", async () => {
    const { service, prisma } = setup({ entitled: false, addOnRow: null });
    await service.dispatchReviewRequests(NOW);
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
  });

  it("counts an active add-on row even if its catalogue entry predates the unlock", async () => {
    const { service, prisma } = setup({ entitled: false, addOnRow: { id: "ta1" } });
    await service.dispatchReviewRequests(NOW);
    expect(prisma.appointment.findMany).toHaveBeenCalled();
  });

  it(`publishes a review left in moderation for ${MODERATION_GRACE_DAYS} days`, async () => {
    const { service, prisma } = setup({ entitled: false });
    await service.dispatchReviewRequests(NOW);
    expect(prisma.review.updateMany).toHaveBeenCalledWith({
      where: {
        status: ReviewStatus.moderation,
        submittedAt: { lte: new Date(NOW.getTime() - MODERATION_GRACE_DAYS * 24 * HOUR) },
      },
      data: { status: ReviewStatus.published, moderatedAt: NOW, moderatedById: null },
    });
  });
});

describe("ReviewsService public page", () => {
  const pending = {
    id: "rev-1",
    tenantId: "t1",
    clientId: "c1",
    appointmentId: "appt-1",
    status: ReviewStatus.pending,
    rating: 0,
    reviewTokenExpiresAt: new Date(Date.now() + 86400_000),
  };
  const token = "abcdefghijklmnopqrstuvwx";

  it("stores the answer for moderation, atomically, with the publish consent and its version", async () => {
    const { service, prisma } = setup({ review: pending, profile: { placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4" } });
    const out = await service.submit(token, { rating: 5, comment: "  Genial  ", publishConsent: true });
    const call = prisma.review.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: "rev-1", status: ReviewStatus.pending });
    expect(call.data).toMatchObject({
      rating: 5,
      comment: "Genial",
      status: ReviewStatus.moderation,
      publishConsent: "granted",
      publishConsentVersion: PUBLISH_CONSENT_VERSION,
    });
    expect(call.data.publishConsentAt).toBeInstanceOf(Date);
    expect(prisma.review.update).not.toHaveBeenCalled();
    expect(out.googleReviewLink).toContain("placeid=ChIJN1t_tDeuEmsRUsoyG83frY4");
  });

  it("an unticked box keeps the review private", async () => {
    const { service, prisma } = setup({ review: pending });
    const out = await service.submit(token, { rating: 2 });
    expect(prisma.review.updateMany.mock.calls[0][0].data.publishConsent).toBe("declined");
    expect(out.publishConsent).toBe("declined");
  });

  it("gives the same Google link whatever the rating", async () => {
    const low = setup({ review: pending, profile: { placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4" } });
    const high = setup({ review: pending, profile: { placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4" } });
    const a = await low.service.submit(token, { rating: 1 });
    const b = await high.service.submit(token, { rating: 5 });
    expect(a.googleReviewLink).toBe(b.googleReviewLink);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it("a submit that loses the race gets the 409, not a second answer", async () => {
    const { service, prisma } = setup({ review: pending, submitCount: 0 });
    await expect(service.submit(token, { rating: 5 })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("refuses a second answer and an expired link", async () => {
    const answered = setup({ review: { ...pending, status: ReviewStatus.moderation, rating: 4 } });
    await expect(answered.service.submit(token, { rating: 5 })).rejects.toBeInstanceOf(ConflictException);
    const expired = setup({ review: { ...pending, reviewTokenExpiresAt: new Date(Date.now() - 1000) } });
    await expect(expired.service.submit(token, { rating: 5 })).rejects.toBeInstanceOf(GoneException);
  });

  it("rejects malformed tokens without a lookup", async () => {
    const { service, prisma } = setup();
    await expect(service.getPublic("../x")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.review.findUnique).not.toHaveBeenCalled();
  });

  it("opt-out turns review requests off on every channel, keeping the other preferences", async () => {
    const { service, prisma } = setup({
      review: pending,
      existingPrefs: { preferences: { appointment_reminder_24h: { email: true } } },
    });
    await service.optOut(token);
    expect(prisma.notificationPreference.upsert.mock.calls[0][0].update.preferences).toEqual({
      appointment_reminder_24h: { email: true },
      review_request: { inApp: false, email: false, sms: false, whatsapp: false },
    });
  });

  it("records the Google click only for an answered review", async () => {
    const pendingCase = setup({ review: pending });
    await pendingCase.service.recordGoogleClick(token);
    expect(pendingCase.prisma.review.update).not.toHaveBeenCalled();
    const answered = setup({ review: { ...pending, status: ReviewStatus.moderation, rating: 5 } });
    await answered.service.recordGoogleClick(token);
    expect(answered.prisma.review.update.mock.calls[0][0].data.googleLinkClickedAt).toBeInstanceOf(Date);
  });
});

describe("ReviewsService panel", () => {
  const actor = { id: "u1", role: "owner" };

  it("analytics: the average counts every answered rating but the rejected ones", async () => {
    const { service, prisma } = setup();
    prisma.review.findMany.mockResolvedValueOnce([
      { rating: 0, status: ReviewStatus.pending, professionalId: "p1", googleLinkClickedAt: null },
      { rating: 5, status: ReviewStatus.published, professionalId: "p1", googleLinkClickedAt: new Date() },
      { rating: 3, status: ReviewStatus.moderation, professionalId: "p1", googleLinkClickedAt: null },
      { rating: 1, status: ReviewStatus.rejected, professionalId: "p1", googleLinkClickedAt: null, moderationReason: "spam" },
      {
        rating: 1,
        status: ReviewStatus.rejected,
        professionalId: "p1",
        googleLinkClickedAt: null,
        moderationReason: "legacy_unspecified",
      },
    ]);
    const a = await service.analytics("t1");
    expect(a).toMatchObject({
      total: 2,
      answered: 4,
      rejected: 2,
      averageRating: 4,
      distribution: [0, 0, 1, 0, 1],
      requestsSent: 5,
      responseRate: 0.8,
      pendingModeration: 1,
      legacyRejections: 1,
      googleClicks: 1,
    });
  });

  it("cannot moderate a request the client has not answered", async () => {
    const { service, prisma } = setup();
    prisma.review.findFirst.mockResolvedValueOnce({ id: "r", status: ReviewStatus.pending });
    await expect(service.moderate("t1", "r", "approve", undefined, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects only with a listed reason", async () => {
    const { service, prisma } = setup();
    prisma.review.findFirst.mockResolvedValue({ id: "r", status: ReviewStatus.moderation, rating: 1 });
    for (const reason of [undefined, "", "mala", "legacy_unspecified"]) {
      await expect(service.moderate("t1", "r", "reject", reason, actor)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.review.update).not.toHaveBeenCalled();
  });

  it("stores the reason, who and when, logs it, and never returns the link's token", async () => {
    const { service, prisma, auditLog } = setup({ review: { reviewToken: "secret-token-value-123", requestMessageId: "em1" } });
    prisma.review.findFirst.mockResolvedValueOnce({ id: "r", status: ReviewStatus.published, rating: 1 });
    const out: any = await service.moderate("t1", "r", "reject", "personal_data", actor);
    const data = prisma.review.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: ReviewStatus.rejected, moderationReason: "personal_data", moderatedById: "u1" });
    expect(data.moderatedAt).toBeInstanceOf(Date);
    expect(auditLog.record).toHaveBeenCalledWith(
      "review.rejected",
      expect.objectContaining({ actorId: "u1", tenantId: "t1", metadata: expect.objectContaining({ reason: "personal_data" }) }),
    );
    expect(out).not.toHaveProperty("reviewToken");
    expect(out).not.toHaveProperty("requestMessageId");
    expect(out).toMatchObject({ moderatedByName: "Lucía Pérez", moderationReasonLabel: "Datos personales" });
  });

  it("approving clears the reason", async () => {
    const { service, prisma } = setup();
    prisma.review.findFirst.mockResolvedValueOnce({ id: "r", status: ReviewStatus.rejected, rating: 2 });
    await service.moderate("t1", "r", "approve", undefined, actor);
    expect(prisma.review.update.mock.calls[0][0].data).toMatchObject({
      status: ReviewStatus.published,
      moderationReason: null,
      moderatedById: "u1",
    });
  });

  it("the booking page averages every rating not rejected, and lists only consented, approved ones", async () => {
    const { service, prisma } = setup();
    prisma.review.aggregate.mockResolvedValueOnce({ _avg: { rating: 3.5 }, _count: { _all: 4 } });
    prisma.review.findMany.mockResolvedValueOnce([
      { id: "r1", rating: 5, comment: "Genial", clientId: "c1", submittedAt: NOW, createdAt: NOW },
    ]);
    prisma.client.findMany.mockResolvedValueOnce([{ id: "c1", firstName: "Ana", lastName: "García" }]);
    const out = await service.publicForTenant("t1");
    expect(prisma.review.aggregate.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      status: { in: [ReviewStatus.moderation, ReviewStatus.published] },
      rating: { gte: 1, lte: 5 },
    });
    expect(prisma.review.findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      status: ReviewStatus.published,
      rating: { gte: 1, lte: 5 },
      publishConsent: { in: ["granted", "legacy"] },
    });
    expect(out).toEqual({
      averageRating: 3.5,
      total: 4,
      reviews: [{ id: "r1", rating: 5, comment: "Genial", author: "Ana G.", date: NOW }],
      rejectionReasons: ["Insultos o contenido ofensivo", "Datos personales", "No habla del servicio", "Spam o duplicada"],
    });
  });
});
