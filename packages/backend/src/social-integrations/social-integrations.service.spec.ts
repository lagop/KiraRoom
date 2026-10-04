import { NotFoundException, NotImplementedException } from "@nestjs/common";
import { SocialPlatform } from "@prisma/client";
import { SocialIntegrationsService } from "./social-integrations.service";

/**
 * These endpoints invented data: a "sync" wrote "Sample Salon" with a random
 * rating into the salon's Google profile, connecting a platform stored a
 * `mock_token_...`, publishing a post set it to example.com, and a reply to
 * a Google review was saved as if Google had it. None of it talks to Google
 * or Meta. They now refuse with the reason, and touch nothing.
 */
function setup() {
  const prisma: any = {
    googleBusinessProfile: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(async ({ create }: any) => create),
    },
    googleReview: { update: jest.fn() },
    socialConnection: { upsert: jest.fn(), findUnique: jest.fn(async () => null), update: jest.fn() },
    socialPost: {
      findFirst: jest.fn(async () => null),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  return { service: new SocialIntegrationsService(prisma), prisma };
}

describe("SocialIntegrationsService: no simulated Google or social data", () => {
  it("does not invent a Google profile on sync", async () => {
    const { service, prisma } = setup();
    await expect(service.syncGoogleBusinessProfile("t1")).rejects.toBeInstanceOf(NotImplementedException);
    expect(prisma.googleBusinessProfile.update).not.toHaveBeenCalled();
  });

  it("does not create a profile when one is only read, and says the API is unavailable", async () => {
    const { service, prisma } = setup();
    const out = await service.getGoogleBusinessProfile("t1");
    expect(out).toEqual({ profile: null, api: { available: false, reason: expect.stringContaining("no está disponible") } });
    expect(prisma.googleBusinessProfile.create).not.toHaveBeenCalled();
  });

  it("does not pretend to reply to a Google review or list them", async () => {
    const { service, prisma } = setup();
    await expect(service.replyToGoogleReview("t1", "r1", "Gracias")).rejects.toBeInstanceOf(NotImplementedException);
    await expect(service.getGoogleReviews("t1")).rejects.toBeInstanceOf(NotImplementedException);
    expect(prisma.googleReview.update).not.toHaveBeenCalled();
  });

  it("does not store a mock token on 'connect'", async () => {
    const { service, prisma } = setup();
    await expect(service.handleOAuthCallback("t1", SocialPlatform.GOOGLE, "code")).rejects.toBeInstanceOf(
      NotImplementedException,
    );
    await expect(service.getOAuthUrl("t1", SocialPlatform.FACEBOOK)).rejects.toBeInstanceOf(NotImplementedException);
    expect(prisma.socialConnection.upsert).not.toHaveBeenCalled();
  });

  it("only stores the review-request switch on the profile", async () => {
    const { service, prisma } = setup();
    await service.updateGoogleBusinessProfile("t1", { enableReviewRequests: true, enableOnlineBooking: true } as any);
    expect(prisma.googleBusinessProfile.upsert.mock.calls[0][0].update).toEqual({ enableReviewRequests: true });
  });

  it("will not touch another salon's post", async () => {
    const { service, prisma } = setup();
    await expect(service.updatePost("t1", "p-other", { content: "x" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deletePost("t1", "p-other")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.publishPost("t1", "p-other")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.socialPost.update).not.toHaveBeenCalled();
    expect(prisma.socialPost.delete).not.toHaveBeenCalled();
  });

  it("does not mark a post as published", async () => {
    const { service, prisma } = setup();
    prisma.socialPost.findFirst.mockResolvedValueOnce({ id: "p1" });
    await expect(service.publishPost("t1", "p1")).rejects.toBeInstanceOf(NotImplementedException);
    expect(prisma.socialPost.update).not.toHaveBeenCalled();
  });
});
