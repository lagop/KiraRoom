import type { PrismaService } from "../common/prisma/prisma.service";
import type { ConsentFormField } from "./consent.service";

/**
 * A client's choice about commercial communications (promotions and news by
 * email) is a Consent record, like a treatment consent: signed by the client
 * with the exact wording they saw (formSnapshot), hashed IP, timestamp, and
 * never edited -- a later choice revokes the previous record and adds a new
 * one, so the history of grants and withdrawals is kept.
 *
 * The salon site's account page used to keep this as a checkbox in the
 * browser's localStorage: it said "guardado" and nobody else ever knew.
 *
 * The record lives against a per-salon system form (ConsentForm.purpose =
 * 'marketing'), created on first use. That form is not one of the salon's
 * treatment forms: it is never required for a booking and is not listed or
 * editable among them.
 *
 * Exactly one record is active (revokedAt = null) per client once they have
 * chosen; its `responses.accepts` is the choice. No record means they have
 * not chosen: campaigns still reach existing clients then (the customer
 * exception of LSSI art. 21.2), and stop as soon as they say no.
 *
 * WhatsApp promotions are a separate choice with its own system form
 * (purpose 'marketing_whatsapp'), and there silence is a no: Meta's business
 * messaging policy only allows marketing messages to people who opted in to
 * receive them from that business on WhatsApp. The opt-in comes from the
 * client's account, or is recorded by the salon when the client agreed in
 * person (responses.source = "salon", with who recorded it).
 */
export const MARKETING_PURPOSE = "marketing";
export const MARKETING_FIELD_ID = "accepts";

export const MARKETING_FORM_NAME = "Comunicaciones comerciales";

export const WHATSAPP_MARKETING_PURPOSE = "marketing_whatsapp";
export const WHATSAPP_MARKETING_FORM_NAME = "Promociones por WhatsApp";

/** System forms: never listed, edited, required for a booking or signed publicly. */
export const SYSTEM_CONSENT_PURPOSES = [MARKETING_PURPOSE, WHATSAPP_MARKETING_PURPOSE];

export type MarketingChannel = "email" | "whatsapp";

/** The wording the client agrees to. Changing it means a new form version. */
export const MARKETING_FIELDS: ConsentFormField[] = [
  {
    id: MARKETING_FIELD_ID,
    type: "boolean",
    label:
      "Quiero recibir por email promociones, ofertas y novedades del salón. " +
      "Puedo retirar este consentimiento cuando quiera desde mi cuenta.",
    required: false,
  },
];

/** The WhatsApp wording: the business, the channel and how to stop, as Meta asks. */
export const WHATSAPP_MARKETING_FIELDS: ConsentFormField[] = [
  {
    id: MARKETING_FIELD_ID,
    type: "boolean",
    label:
      "Quiero recibir por WhatsApp promociones, ofertas y novedades del salón. " +
      "Puedo darme de baja cuando quiera respondiendo BAJA o desde mi cuenta.",
    required: false,
  },
];

export function purposeOf(channel: MarketingChannel): string {
  return channel === "whatsapp" ? WHATSAPP_MARKETING_PURPOSE : MARKETING_PURPOSE;
}

export function marketingFormFor(channel: MarketingChannel) {
  return channel === "whatsapp"
    ? { name: WHATSAPP_MARKETING_FORM_NAME, fields: WHATSAPP_MARKETING_FIELDS }
    : { name: MARKETING_FORM_NAME, fields: MARKETING_FIELDS };
}

export type MarketingConsentStatus = "granted" | "refused" | "none";

export interface MarketingConsentState {
  status: MarketingConsentStatus;
  /** When the current choice was recorded; null when there is none. */
  decidedAt: string | null;
  /** The wording of the choice, as recorded (or as it would be). */
  text: string;
}

/** The state a client's active marketing record (if any) represents. */
export function marketingStateOf(
  record: { responses: unknown; signedAt: Date; formSnapshot?: unknown } | null,
  channel: MarketingChannel = "email",
): MarketingConsentState {
  const text =
    (Array.isArray(record?.formSnapshot)
      ? (record!.formSnapshot as ConsentFormField[]).find((f) => f?.id === MARKETING_FIELD_ID)?.label
      : undefined) ?? marketingFormFor(channel).fields[0].label;
  if (!record) return { status: "none", decidedAt: null, text };
  const accepts = (record.responses as Record<string, unknown> | null)?.[MARKETING_FIELD_ID];
  return {
    status: accepts === true ? "granted" : "refused",
    decidedAt: record.signedAt.toISOString(),
    text,
  };
}

/**
 * Clients of the salon who said no to commercial communications. Campaign
 * senders leave them out.
 */
export async function clientsWhoRefusedMarketing(
  prisma: Pick<PrismaService, "consent">,
  tenantId: string,
  clientIds?: string[],
): Promise<Set<string>> {
  const rows = await prisma.consent.findMany({
    where: {
      tenantId,
      revokedAt: null,
      form: { purpose: MARKETING_PURPOSE },
      ...(clientIds ? { clientId: { in: clientIds } } : {}),
    },
    select: { clientId: true, responses: true },
  });
  return new Set(
    rows
      .filter((r) => (r.responses as Record<string, unknown> | null)?.[MARKETING_FIELD_ID] === false)
      .map((r) => r.clientId),
  );
}

/**
 * Clients of the salon who opted in to WhatsApp promotions and have not
 * withdrawn. Only they may receive a WhatsApp campaign.
 */
export async function clientsWhoAcceptedWhatsAppMarketing(
  prisma: Pick<PrismaService, "consent">,
  tenantId: string,
  clientIds?: string[],
): Promise<Set<string>> {
  const rows = await prisma.consent.findMany({
    where: {
      tenantId,
      revokedAt: null,
      form: { purpose: WHATSAPP_MARKETING_PURPOSE },
      ...(clientIds ? { clientId: { in: clientIds } } : {}),
    },
    select: { clientId: true, responses: true },
  });
  return new Set(
    rows
      .filter((r) => (r.responses as Record<string, unknown> | null)?.[MARKETING_FIELD_ID] === true)
      .map((r) => r.clientId),
  );
}
