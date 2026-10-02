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
 */
export const MARKETING_PURPOSE = "marketing";
export const MARKETING_FIELD_ID = "accepts";

export const MARKETING_FORM_NAME = "Comunicaciones comerciales";

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
): MarketingConsentState {
  const text =
    (Array.isArray(record?.formSnapshot)
      ? (record!.formSnapshot as ConsentFormField[]).find((f) => f?.id === MARKETING_FIELD_ID)?.label
      : undefined) ?? MARKETING_FIELDS[0].label;
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
