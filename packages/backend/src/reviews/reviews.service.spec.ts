import { BadRequestException, ConflictException, GoneException, NotFoundException } from "@nestjs/common";
import { ReviewSource, ReviewStatus } from "@prisma/client";
import {
  CLIENT_COOLDOWN_DAYS,
  ReviewsService,
  googleWriteReviewLink,
  isGoogleReviewUrl,
} from "./reviews.service";

/**
 * Reviews were simulated end to end: two cron jobs raced for the same
 * appointments, one leaving an in-app notice linking to a page that does not
 * exist, the other an English email whose button went to "#"; the add-on
 * sold for it unlocked nothing; and completing an appointment never set the
 * time both jobs selected on. These specs pin the real flow: one request per
 * visit through a channel the client accepts and a provider can deliver,
 * nothing recorded when nothing was sent, the answer stored for moderation,
 * and a Google link that is the salon's own.
 */

const NOW = new Date("2026-10-02T12:00:00.000Z");
const HOUR = 3600_000;

function appointment(over: Partial<any> = {}) {
  return {
    id: "appt-1",
    tenantId: "t1",
    clientId: "c1",
    professionalId: "p1",
    client: { id: "c1", firstName: "Ana", email: "ana@example.test", phone: "600111222", status: "active" },
    service: { name: "Corte" },
    tenant: { name: "Salón Lucía", country: "ES" },
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
  smsConfigured?: boolean;
  whatsapp?: any;
  entitled?: boolean;
  addOnRow?: any;
  review?: any;
  profile?: any;
  existingPrefs?: any;
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
      update: jest.fn(async ({ data }: any) => ({ ...(over.review ?? {}), ...data })),
      delete: jest.fn(async () => ({})),
      aggregate: jest.fn(),
    },
    googleBusinessProfile: {
      findMany: jest.fn(async () => [{ tenantId: "t1" }]),
      findUnique: jest.fn(async () => over.profile ?? null),
      upsert: jest.fn(async () => ({})),
    },
    tenantAddOn: { findFirst: jest.fn(async () => over.addOnRow ?? null) },
    tenant: { findUnique: jest.fn(async () => ({ name: "Salón Lucía", slug: "lucia", logo: null })) },
    notificationPreference: {
      findUnique: jest.fn(async () => over.existingPrefs ?? null),
      upsert: jest.fn(async () => ({})),
    },
    whatsAppConnection: { findUnique: jest.fn(async () => null) },
    client: { findMany: jest.fn(async () => []) },
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
  const sms: any = {
    isConfigured: jest.fn(() => over.smsConfigured ?? false),
    sendSms: jest.fn(async () => ({ success: true })),
  };
  const whatsapp: any = {
    sendReviewRequest: jest.fn(async () => over.whatsapp ?? { sent: false, reason: "not_connected" }),
    standardStatus: jest.fn(async () => []),
  };
  const flags: any = {
    evaluate: jest.fn(async () => ({
      unlocked: over.entitled ?? true,
      ctx: { subscriptionStatus: "active" },
    })),
  };
  const service = new ReviewsService(prisma, config, notifications, email, sms, whatsapp, flags);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { service, prisma, notifications, email, sms, whatsapp, flags };
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

  it("accepts only https links on Google's hosts", () => {
    expect(isGoogleReviewUrl("https://g.page/r/CabcDEF/review")).toBe(true);
    expect(isGoogleReviewUrl("https://search.google.com/local/writereview?placeid=abc")).toBe(true);
    expect(isGoogleReviewUrl("https://www.google.es/maps/place/x")).toBe(true);
    expect(isGoogleReviewUrl("https://maps.app.goo.gl/abc")).toBe(true);
    expect(isGoogleReviewUrl("http://g.page/r/x")).toBe(false);
    expect(isGoogleReviewUrl("https://google.com.evil.test/x")).toBe(false);
    expect(isGoogleReviewUrl("https://evil.test/?google.com")).toBe(false);
    expect(isGoogleReviewUrl("javascript:alert(1)")).toBe(false);
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

  it("says plainly that the Google API is not available", async () => {
    const { service } = setup();
    const s = await service.getSettings("t1");
    expect(s.googleApi.available).toBe(false);
    expect(s.channels.whatsapp).toBe("not_connected");
  });
});

describe("ReviewsService.dispatchForTenant", () => {
  it("emails the client a working link and records the request", async () => {
    const { service, prisma, email } = setup();
    const out = await service.dispatchForTenant("t1", NOW);
    expect(out).toEqual({ candidates: 1, sent: 1 });

    // Only visits completed 2 to 72 hours ago.
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.completionTime.lte).toEqual(new Date(NOW.getTime() - 2 * HOUR));
    expect(where.completionTime.gte).toEqual(new Date(NOW.getTime() - 72 * HOUR));

    const created = prisma.review.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ tenantId: "t1", appointmentId: "appt-1", status: ReviewStatus.pending, rating: 0 });
    const args = email.sendReviewRequest.mock.calls[0][0];
    expect(args.reviewUrl).toBe(`https://app.example.test/public/r/${created.reviewToken}`);
    expect(args.optOutUrl).toBe(`${args.reviewUrl}?baja=1`);
    expect(prisma.review.delete).not.toHaveBeenCalled();
  });

  it("sends nothing, records nothing, and logs why when no provider is configured", async () => {
    const { service, prisma, email } = setup({ emailConfigured: false });
    const out = await service.dispatchForTenant("t1", NOW);
    expect(out.sent).toBe(0);
    expect(email.sendReviewRequest).not.toHaveBeenCalled();
    expect(prisma.review.delete).toHaveBeenCalledWith({ where: { id: "rev-1" } });
    expect((service as any).logger.log).toHaveBeenCalledWith(expect.stringContaining("RESEND_API_KEY"));
    // Still claimed: it is not retried every hour.
    expect(prisma.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: "appt-1", reviewRequestSent: false },
      data: { reviewRequestSent: true },
    });
  });

  it("respects the client's preferences, channel by channel", async () => {
    const { service, email, whatsapp, sms, prisma } = setup({
      prefs: { email: false, whatsapp: true, sms: false },
      smsConfigured: true,
      whatsapp: { sent: true, messageId: "wamid" },
    });
    await service.dispatchForTenant("t1", NOW);
    expect(email.sendReviewRequest).not.toHaveBeenCalled();
    expect(whatsapp.sendReviewRequest).toHaveBeenCalledWith("t1", expect.objectContaining({ phone: "600111222" }));
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(prisma.review.update).toHaveBeenCalledWith({ where: { id: "rev-1" }, data: { source: ReviewSource.whatsapp_link } });
  });

  it("falls back to SMS only when the client accepts it and Twilio is configured", async () => {
    const { service, sms, prisma } = setup({ prefs: { email: false, sms: true }, smsConfigured: true });
    await service.dispatchForTenant("t1", NOW);
    expect(sms.sendSms.mock.calls[0][0].body).toContain("https://app.example.test/public/r/");
    expect(prisma.review.update).toHaveBeenCalledWith({ where: { id: "rev-1" }, data: { source: ReviewSource.sms_link } });
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
  });

  it("does not ask a blocked client", async () => {
    const { service, email } = setup({
      candidates: [appointment({ client: { id: "c1", firstName: "Ana", email: "a@x.test", phone: null, status: "blocked" } })],
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

  it("stores the answer for moderation and hands back the salon's Google link", async () => {
    const { service, prisma } = setup({ review: pending, profile: { placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4" } });
    const out = await service.submit(token, { rating: 5, comment: "  Genial  " });
    expect(prisma.review.update.mock.calls[0][0].data).toMatchObject({
      rating: 5,
      comment: "Genial",
      status: ReviewStatus.moderation,
    });
    expect(out.googleReviewLink).toContain("placeid=ChIJN1t_tDeuEmsRUsoyG83frY4");
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
  it("analytics ignore unanswered requests instead of counting them as 0 stars", async () => {
    const { service, prisma } = setup();
    prisma.review.findMany.mockResolvedValueOnce([
      { rating: 0, status: ReviewStatus.pending, professionalId: "p1", googleLinkClickedAt: null },
      { rating: 5, status: ReviewStatus.published, professionalId: "p1", googleLinkClickedAt: new Date() },
      { rating: 3, status: ReviewStatus.moderation, professionalId: "p1", googleLinkClickedAt: null },
    ]);
    const a = await service.analytics("t1");
    expect(a).toMatchObject({
      total: 2,
      averageRating: 4,
      distribution: [0, 0, 1, 0, 1],
      requestsSent: 3,
      responseRate: 0.67,
      pendingModeration: 1,
      googleClicks: 1,
    });
  });

  it("cannot moderate a request the client has not answered", async () => {
    const { service, prisma } = setup();
    prisma.review.findFirst.mockResolvedValueOnce({ id: "r", status: ReviewStatus.pending });
    await expect(service.moderate("t1", "r", "approve")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the booking page shows approved reviews with first name and initial only", async () => {
    const { service, prisma } = setup();
    prisma.review.aggregate.mockResolvedValueOnce({ _avg: { rating: 4.5 }, _count: { _all: 2 } });
    prisma.review.findMany.mockResolvedValueOnce([
      { id: "r1", rating: 5, comment: "Genial", clientId: "c1", submittedAt: NOW, createdAt: NOW },
    ]);
    prisma.client.findMany.mockResolvedValueOnce([{ id: "c1", firstName: "Ana", lastName: "García" }]);
    const out = await service.publicForTenant("t1");
    expect(prisma.review.aggregate.mock.calls[0][0].where).toMatchObject({ status: ReviewStatus.published });
    expect(out).toEqual({
      averageRating: 4.5,
      total: 2,
      reviews: [{ id: "r1", rating: 5, comment: "Genial", author: "Ana G.", date: NOW }],
    });
  });
});
