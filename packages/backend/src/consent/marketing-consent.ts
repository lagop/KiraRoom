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
 * receive them from that business on WhatsApp. The salon records the opt-in
 * when the client agreed in person (responses.source = "salon", with who
 * recorded it).
 *
 * Clients have no accounts (nothing sets a client password), so the wording
 * never sends them to one: they stop emails with the link in every email,
 * WhatsApp promotions by replying BAJA, and anything by asking the salon.
 *
 * Where a choice was made is kept in responses.source: "booking" (the salon's
 * booking page), "widget" (the embeddable widget), "salon" (the panel, with
 * recordedBy) or absent (the old account page, or a BAJA reply). A choice
 * made on a form keeps the exact text that was next to the box in
 * responses.shown, besides the form's own wording in formSnapshot.
 *
 * WhatsApp appointment notices (confirmations, reminders, changes, sent with
 * Meta UTILITY templates) are not marketing, but the client asks for them by
 * ticking a box, or the salon turns them on when she asks: that request is a
 * record too (purpose 'notices_whatsapp'), so the salon can show when and
 * where it was given. The switch itself is her notification preferences
 * (see client-notices.ts).
 */
export const MARKETING_PURPOSE = "marketing";
export const MARKETING_FIELD_ID = "accepts";

export const MARKETING_FORM_NAME = "Comunicaciones comerciales";

export const WHATSAPP_MARKETING_PURPOSE = "marketing_whatsapp";
export const WHATSAPP_MARKETING_FORM_NAME = "Promociones por WhatsApp";

export const WHATSAPP_NOTICES_PURPOSE = "notices_whatsapp";
export const WHATSAPP_NOTICES_FORM_NAME = "Avisos de citas por WhatsApp";

/** System forms: never listed, edited, required for a booking or signed publicly. */
export const SYSTEM_CONSENT_PURPOSES = [MARKETING_PURPOSE, WHATSAPP_MARKETING_PURPOSE, WHATSAPP_NOTICES_PURPOSE];

export type MarketingChannel = "email" | "whatsapp";

/**
 * The client choices kept as system consent records: promotions by email,
 * promotions by WhatsApp, and appointment notices by WhatsApp.
 */
export type ChoiceKind = MarketingChannel | "whatsapp_notices";

/** Where a choice was made on a form (responses.source). */
export type ChoiceSource = "booking" | "widget" | "salon";

/**
 * The boxes of the booking page and the widget, word for word as the
 * frontend shows them (packages/frontend/lib/public-booking.ts,
 * BOOKING_CHOICE_TEXT): the record keeps what the client saw.
 */
export const BOOKING_EMAIL_REFUSAL_TEXT =
  "No quiero recibir promociones ni novedades del salón por email. " +
  "Si no marcas la casilla, el salón puede enviarte por email promociones de servicios parecidos " +
  "a los que reservas. Puedes darte de baja cuando quieras con el enlace que llega en cada email.";

export const BOOKING_WHATSAPP_NOTICES_TEXT =
  "Recibir los avisos de mi cita por WhatsApp (confirmación, recordatorios y cambios).";

/** The wording the client agrees to. Changing it means a new form version (ensureMarketingForm). */
export const MARKETING_FIELDS: ConsentFormField[] = [
  {
    id: MARKETING_FIELD_ID,
    type: "boolean",
    label:
      "Quiero recibir por email promociones, ofertas y novedades del salón. " +
      "Puedo darme de baja cuando quiera con el enlace que llega en cada email o pidiéndoselo al salón.",
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
      "Puedo darme de baja cuando quiera respondiendo BAJA o pidiéndoselo al salón.",
    required: false,
  },
];

/** Appointment notices by WhatsApp: transactional, asked for by the client. */
export const WHATSAPP_NOTICES_FIELDS: ConsentFormField[] = [
  {
    id: MARKETING_FIELD_ID,
    type: "boolean",
    label:
      "Quiero recibir por WhatsApp los avisos de mis citas (confirmación, recordatorios y cambios). " +
      "Puedo dejar de recibirlos pidiéndoselo al salón.",
    required: false,
  },
];

export function purposeOf(channel: ChoiceKind): string {
  if (channel === "whatsapp_notices") return WHATSAPP_NOTICES_PURPOSE;
  return channel === "whatsapp" ? WHATSAPP_MARKETING_PURPOSE : MARKETING_PURPOSE;
}

export function marketingFormFor(channel: ChoiceKind) {
  if (channel === "whatsapp_notices") {
    return { name: WHATSAPP_NOTICES_FORM_NAME, fields: WHATSAPP_NOTICES_FIELDS };
  }
  return channel === "whatsapp"
    ? { name: WHATSAPP_MARKETING_FORM_NAME, fields: WHATSAPP_MARKETING_FIELDS }
    : { name: MARKETING_FORM_NAME, fields: MARKETING_FIELDS };
}

/**
 * Does a stored system form say exactly `fields`? When the wording changes
 * (as when "desde mi cuenta" went), the form gets a new version, and the
 * records signed on the old one keep the old text in their snapshot.
 */
export function sameWording(stored: unknown, fields: ConsentFormField[]): boolean {
  if (!Array.isArray(stored) || stored.length !== fields.length) return false;
  return fields.every((f, i) => {
    const s = stored[i] as Partial<ConsentFormField> | undefined;
    return s?.id === f.id && s?.label === f.label;
  });
}

export type MarketingConsentStatus = "granted" | "refused" | "none";

export interface MarketingConsentState {
  status: MarketingConsentStatus;
  /** When the current choice was recorded; null when there is none. */
  decidedAt: string | null;
  /** The wording of the choice, as recorded (or as it would be). */
  text: string;
  /**
   * Where it was made: "booking", "widget" or "salon"; null when there is
   * no choice, or it came from the old account page or a BAJA reply.
   */
  source?: string | null;
}

/** The state a client's active marketing record (if any) represents. */
export function marketingStateOf(
  record: { responses: unknown; signedAt: Date; formSnapshot?: unknown } | null,
  channel: ChoiceKind = "email",
): MarketingConsentState {
  const text =
    (Array.isArray(record?.formSnapshot)
      ? (record!.formSnapshot as ConsentFormField[]).find((f) => f?.id === MARKETING_FIELD_ID)?.label
      : undefined) ?? marketingFormFor(channel).fields[0].label;
  if (!record) return { status: "none", decidedAt: null, text, source: null };
  const responses = record.responses as Record<string, unknown> | null;
  const accepts = responses?.[MARKETING_FIELD_ID];
  return {
    status: accepts === true ? "granted" : "refused",
    decidedAt: record.signedAt.toISOString(),
    text,
    source: typeof responses?.source === "string" ? responses.source : null,
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
