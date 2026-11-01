import type { PrismaService } from "../common/prisma/prisma.service";
import type { EmailSuppressionService } from "../email-campaigns/email-suppression.service";

/** The part of a Resend webhook event this reads (see ResendWebhookEvent). */
export interface ReviewEmailEvent {
  type: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; message?: string };
  };
}

/**
 * A review request email that hard-bounced or drew a complaint puts the
 * address on the salon's suppression list, so the next request (and its
 * campaigns) skip it. The request is found by the Resend id stored when it
 * was sent (Review.requestMessageId); any other email is not ours and is
 * left alone. Returns whether it suppressed an address.
 *
 * Called from ResendEventsService.handle for emails that are not campaign
 * emails, before its generic transactional handling.
 */
export async function suppressFromReviewRequestEvent(
  prisma: Pick<PrismaService, "review" | "client">,
  suppressions: Pick<EmailSuppressionService, "suppress">,
  event: ReviewEmailEvent,
): Promise<boolean> {
  const emailId = event.data?.email_id;
  if (!emailId) return false;
  const bounced = event.type === "email.bounced" && isPermanent(event.data?.bounce?.type);
  const complained = event.type === "email.complained";
  if (!bounced && !complained) return false;

  const review = await prisma.review.findUnique({
    where: { requestMessageId: emailId },
    select: { tenantId: true, clientId: true },
  });
  if (!review) return false;

  const to = Array.isArray(event.data?.to) ? event.data?.to[0] : event.data?.to;
  let address = to ?? null;
  if (!address) {
    const client = await prisma.client.findFirst({
      where: { id: review.clientId, tenantId: review.tenantId },
      select: { email: true },
    });
    address = client?.email ?? null;
  }
  if (!address) return false;

  await suppressions.suppress(
    review.tenantId,
    address,
    complained ? "complaint" : "hard_bounce",
    complained ? "Queja sobre la petición de opinión" : event.data?.bounce?.message ?? null,
  );
  return true;
}

/** Same rule as resend-events.service.ts: Resend sends "Permanent" for hard bounces. */
function isPermanent(type: string | undefined): boolean {
  return !type || type.toLowerCase() === "permanent";
}
