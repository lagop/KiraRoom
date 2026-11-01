import { Prisma } from "@prisma/client";
import { SYSTEM_CONSENT_PURPOSES } from "../consent/marketing-consent";

/**
 * Right to erasure (RGPD art. 17) for clients of a salon.
 *
 * The client row itself stays, so her appointments, payments, invoices and
 * the salon's figures keep pointing at something; everything on it that
 * identifies her or describes her is erased, and so is the personal data
 * kept about her elsewhere. Invoices are not touched: Spanish law requires
 * the salon to keep them as issued (4 years, LGT art. 66; 6 for the
 * accounting books, CCom art. 30), and each one carries its own recipient
 * snapshot (recipientName / recipientTaxId), never the live client.
 *
 * Used for one client (the client file, /admin/clients/:id/anonymize) and
 * for every client of a salon that leaves the platform (saas GDPR tool).
 */

export const ANONYMIZED_FIRST_NAME = "Clienta";
export const ANONYMIZED_LAST_NAME = "anonimizada";
export const ANONYMIZED_NAME = `${ANONYMIZED_FIRST_NAME} ${ANONYMIZED_LAST_NAME}`;

type ClientColumn = `${Prisma.ClientScalarFieldEnum}`;

/**
 * What anonymisation does with every Client column. `kept` columns do not
 * identify her once the rest is gone (ids, dates of the record, the
 * salon's aggregates); `erased` ones are reset by anonymizedClientData().
 *
 * client-anonymize.spec.ts fails when a Client column is added without a
 * decision here (and the Record type stops the build), so a new personal
 * column cannot survive an erasure by default.
 */
export const CLIENT_COLUMN_ON_ERASURE: Record<ClientColumn, "kept" | "erased"> = {
  id: "kept",
  createdAt: "kept",
  updatedAt: "kept",
  tenantId: "kept",
  firstName: "erased",
  lastName: "erased",
  email: "erased",
  phone: "erased",
  taxId: "erased",
  taxIdType: "erased",
  dateOfBirth: "erased",
  gender: "erased",
  profileImage: "erased",
  status: "erased",
  preferredLanguage: "erased",
  preferredServices: "erased",
  preferredProfessionals: "erased",
  preferredTimes: "erased",
  communicationPreferences: "erased",
  // The salon's figures: spend, visits, points. Not about who she is.
  loyaltyPoints: "kept",
  loyaltyTier: "kept",
  totalSpent: "kept",
  visitCount: "kept",
  averageSpent: "kept",
  firstVisit: "kept",
  lastVisit: "kept",
  lastReengagementSent: "kept",
  source: "kept",
  allergies: "erased",
  medicalConditions: "erased",
  notes: "erased",
  tags: "erased",
  passwordHash: "erased",
  passwordResetToken: "erased",
  passwordResetExpires: "erased",
  tokenVersion: "erased",
};

/** The values the erased columns get. tokenVersion goes up: her sessions end. */
export function anonymizedClientData() {
  return {
    firstName: ANONYMIZED_FIRST_NAME,
    lastName: ANONYMIZED_LAST_NAME,
    email: null,
    phone: null,
    taxId: null,
    taxIdType: null,
    dateOfBirth: null,
    gender: null,
    profileImage: null,
    // No dedicated marker exists: inactive, with no contact data and no
    // password, nobody can reach her or sign in as her.
    status: "inactive",
    preferredLanguage: "es",
    preferredServices: [],
    preferredProfessionals: [],
    preferredTimes: {},
    communicationPreferences: {},
    allergies: [],
    medicalConditions: [],
    notes: null,
    tags: [],
    passwordHash: null,
    passwordResetToken: null,
    passwordResetExpires: null,
    tokenVersion: { increment: 1 },
  } satisfies Prisma.ClientUpdateManyMutationInput;
}

/**
 * The receptionist's WhatsApp conversations with someone who was not
 * matched to a client are keyed by her number (context.visitorKey =
 * "whatsapp-<digits as Meta sends them>"). The keys her phone may have had.
 */
export function whatsappVisitorKeys(phone: string | null | undefined): string[] {
  let digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 6) return [];
  const keys = [`whatsapp-${digits}`];
  // A Spanish number stored without the country code.
  if (digits.length === 9) keys.push(`whatsapp-34${digits}`);
  return keys;
}

/**
 * Models that point at a client and that anonymisation leaves as they are:
 * money and points, with no personal data of their own (a till sale, PosSale,
 * keeps its amounts and line names; it stores no recipient details). Every other model
 * with a client link is deleted or cleaned by anonymizeClients();
 * client-anonymize.spec.ts fails when a new one is neither.
 */
export const CLIENT_LINKED_MODELS_KEPT = ["Payment", "ClientWallet", "LoyaltyMember", "PromotionUsage", "PosSale"] as const;

export interface AnonymizeSummary {
  clients: number;
}

const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Anonymise these clients of the salon, inside the caller's transaction.
 * Ids that are not clients of `tenantId` are ignored.
 *
 * Deleted: marketing-consent records (with no email or phone left there is
 * nothing to send; nothing reaches an anonymised client), receptionist
 * conversations and their messages, the client profile, wait-list entries,
 * the rebooking cadence and reminders, her notifications and their delivery
 * log, notification preferences, campaign recipient rows and their
 * open/click events, pending review requests, open sign-in sessions.
 *
 * Anonymised in place: signed treatment consents (answers emptied, signer
 * name replaced, IP hash cleared; the form version and dates stay as the
 * record that a consent was signed), free-text notes on her appointments
 * and orders, the recipient name / email / message on gift cards given to
 * her, her reviews (the comment goes and the review is never listed again;
 * only the rating stays, counted anonymously in the salon's average).
 *
 * Kept: appointments, payments, orders, invoices (with their own recipient
 * snapshot), loyalty and wallet balances, promotion usage, and the salon's
 * email suppression list (an address that must never be emailed again).
 */
export async function anonymizeClients(
  tx: Prisma.TransactionClient,
  tenantId: string,
  clientIds: string[],
): Promise<AnonymizeSummary> {
  let total = 0;
  for (const requested of chunks([...new Set(clientIds)])) {
    const clients = await tx.client.findMany({
      where: { tenantId, id: { in: requested } },
      select: { id: true, email: true, phone: true },
    });
    if (clients.length === 0) continue;
    const ids = clients.map((c) => c.id);
    const inIds = { in: ids };
    const emails = [
      ...new Set(
        clients.flatMap((c) => (c.email ? [c.email, c.email.trim().toLowerCase()] : [])),
      ),
    ];
    const visitorKeys = clients.flatMap((c) => whatsappVisitorKeys(c.phone));

    // Consents: marketing choices go; treatment consents lose what she wrote.
    await tx.consent.deleteMany({
      where: { tenantId, clientId: inIds, form: { purpose: { in: SYSTEM_CONSENT_PURPOSES } } },
    });
    await tx.consent.updateMany({
      where: { tenantId, clientId: inIds },
      data: { responses: {}, signatureName: ANONYMIZED_NAME, signatureIpHash: "" },
    });

    // Conversations with the receptionist (messages and intents cascade).
    await tx.chatConversation.deleteMany({ where: { tenantId, clientId: inIds } });
    for (const keys of chunks(visitorKeys, 100)) {
      await tx.chatConversation.deleteMany({
        where: {
          tenantId,
          clientId: null,
          OR: keys.map((key) => ({ context: { path: ["visitorKey"], equals: key } })),
        },
      });
    }

    await tx.clientProfile.deleteMany({ where: { tenantId, clientId: inIds } });
    await tx.waitList.deleteMany({ where: { tenantId, clientId: inIds } });
    await tx.clientCadence.deleteMany({ where: { tenantId, clientId: inIds } });
    await tx.rebookingReminder.deleteMany({ where: { tenantId, clientId: inIds } });
    // Deliveries (with the address each went to) cascade.
    await tx.notification.deleteMany({ where: { tenantId, clientId: inIds } });
    await tx.notificationPreference.deleteMany({ where: { tenantId, clientId: inIds } });

    // Campaigns: the campaign's own counters stay; her row and events go.
    await tx.emailCampaignRecipient.deleteMany({
      where: { clientId: inIds, campaign: { tenantId } },
    });
    if (emails.length > 0) {
      await tx.emailCampaignAnalytics.deleteMany({
        where: { email: { in: emails }, campaign: { tenantId } },
      });
    }
    await tx.whatsAppCampaignRecipient.deleteMany({
      where: { clientId: inIds, campaign: { tenantId } },
    });

    // Reviews: a request she never answered goes. Of what she answered only
    // the rating stays, counted anonymously in the average: the comment
    // goes, the review is never listed on the salon's site again, and its
    // link stops working.
    await tx.review.deleteMany({ where: { tenantId, clientId: inIds, status: "pending" } });
    await tx.review.updateMany({
      where: { tenantId, clientId: inIds },
      data: { reviewToken: null, reviewTokenExpiresAt: null, comment: null, publishConsent: "anonymised" },
    });

    // Visits and purchases stay (the salon's records); free text about her goes.
    await tx.appointment.updateMany({
      where: { tenantId, clientId: inIds },
      data: { notes: null, internalNotes: null, address: null, review: null, feedback: {} },
    });
    await tx.order.updateMany({ where: { tenantId, clientId: inIds }, data: { notes: null } });

    await tx.giftCard.updateMany({
      where: {
        tenantId,
        OR: [
          { recipientId: inIds },
          ...(emails.length > 0 ? [{ recipientEmail: { in: emails } }] : []),
        ],
      },
      data: { recipientName: null, recipientEmail: null, message: null },
    });

    await tx.authSession.updateMany({
      where: { subjectType: "client", subjectId: inIds, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const updated = await tx.client.updateMany({
      where: { tenantId, id: inIds },
      data: anonymizedClientData(),
    });
    total += updated.count;
  }
  return { clients: total };
}
