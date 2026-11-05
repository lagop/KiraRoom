import { suppressFromReviewRequestEvent } from "./review-email-events";

describe("suppressFromReviewRequestEvent", () => {
  function setup(review: any = { tenantId: "t1", clientId: "c1" }, clientEmail: string | null = "ana@example.test") {
    const prisma: any = {
      review: { findUnique: jest.fn(async () => review) },
      client: { findFirst: jest.fn(async () => (clientEmail ? { email: clientEmail } : null)) },
    };
    const suppressions: any = { suppress: jest.fn(async () => undefined) };
    return { prisma, suppressions };
  }

  it("a hard bounce of a review request suppresses the address for that salon", async () => {
    const { prisma, suppressions } = setup();
    const done = await suppressFromReviewRequestEvent(prisma, suppressions, {
      type: "email.bounced",
      data: { email_id: "em1", to: ["Ana@Example.test"], bounce: { type: "Permanent", message: "mailbox gone" } },
    });
    expect(done).toBe(true);
    expect(prisma.review.findUnique).toHaveBeenCalledWith({
      where: { requestMessageId: "em1" },
      select: { tenantId: true, clientId: true },
    });
    expect(suppressions.suppress).toHaveBeenCalledWith("t1", "Ana@Example.test", "hard_bounce", "mailbox gone");
  });

  it("a complaint suppresses it too, falling back to the client's email", async () => {
    const { prisma, suppressions } = setup();
    await suppressFromReviewRequestEvent(prisma, suppressions, { type: "email.complained", data: { email_id: "em1" } });
    expect(suppressions.suppress).toHaveBeenCalledWith("t1", "ana@example.test", "complaint", expect.any(String));
  });

  it("a temporary bounce, a delivery, or an email that is not a review request change nothing", async () => {
    const soft = setup();
    await suppressFromReviewRequestEvent(soft.prisma, soft.suppressions, {
      type: "email.bounced",
      data: { email_id: "em1", to: "a@x.test", bounce: { type: "Transient" } },
    });
    await suppressFromReviewRequestEvent(soft.prisma, soft.suppressions, {
      type: "email.delivered",
      data: { email_id: "em1", to: "a@x.test" },
    });
    expect(soft.suppressions.suppress).not.toHaveBeenCalled();

    const other = setup(null);
    expect(
      await suppressFromReviewRequestEvent(other.prisma, other.suppressions, {
        type: "email.complained",
        data: { email_id: "em9", to: "a@x.test" },
      }),
    ).toBe(false);
    expect(other.suppressions.suppress).not.toHaveBeenCalled();
  });
});
