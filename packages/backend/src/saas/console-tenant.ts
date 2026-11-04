import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { RESERVED_SUBDOMAINS } from "@kira/shared";
import { slugify } from "./saas.helpers";
import { WEB_ADDRESS_MAX, WEB_ADDRESS_MIN, type WebAddressProblem } from "../web-address/web-address-rules";
import { anonymizationDate, retentionStep } from "./retention/salon-retention";

/**
 * What the SaaS console reads and returns of a salon (audit 8 T24): the
 * columns its pages show plus the subscription and retention dates. Never
 * the salon's Stripe secret keys, `features` (where channel credentials
 * live), fiscal or accounting settings, or deletionRestore.
 */
export const CONSOLE_TENANT_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  logo: true,
  coverImage: true,
  website: true,
  instagram: true,
  facebook: true,
  email: true,
  phone: true,
  whatsapp: true,
  street: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  timezone: true,
  currency: true,
  language: true,
  taxId: true,
  taxIdType: true,
  legalName: true,
  plan: true,
  maxLocations: true,
  subscriptionStatus: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  trialEnd: true,
  cancelledAt: true,
  readOnlyUntil: true,
  subscriptionCancelAt: true,
  anonymizationWarnedAt: true,
  anonymizationWarnedFor: true,
  anonymizedAt: true,
  deletionRequestedAt: true,
  deletedAt: true,
  // Only whether there is one (consoleTenantView): ids are not shown.
  stripeSubscriptionId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TenantSelect;

export type ConsoleTenantRow = Prisma.TenantGetPayload<{ select: typeof CONSOLE_TENANT_SELECT }>;

/** The row as the console gets it: the Stripe subscription id becomes a yes/no. */
export function consoleTenantView<T extends { stripeSubscriptionId?: string | null }>(row: T) {
  const { stripeSubscriptionId, ...rest } = row;
  return { ...rest, hasStripeSubscription: !!stripeSubscriptionId };
}

/**
 * The salon's retention state, for the console page (audit 8 T4, T12):
 * until when it is read-only, when it is anonymised, whether the owner was
 * warned for this period, and what the next run would do.
 */
export function retentionView(
  t: Pick<
    ConsoleTenantRow,
    "id" | "name" | "subscriptionStatus" | "readOnlyUntil" | "anonymizationWarnedAt" | "anonymizationWarnedFor" | "anonymizedAt" | "deletionRequestedAt" | "deletedAt"
  >,
  now: Date = new Date(),
) {
  const anonymizeOn = t.readOnlyUntil ? anonymizationDate(t.readOnlyUntil) : null;
  const warnedForThisPeriod =
    !!t.anonymizationWarnedAt &&
    !!t.readOnlyUntil &&
    !!t.anonymizationWarnedFor &&
    t.anonymizationWarnedFor.getTime() === t.readOnlyUntil.getTime();
  const step =
    !t.anonymizedAt && !t.deletedAt
      ? retentionStep(
          {
            id: t.id,
            name: t.name,
            subscriptionStatus: t.subscriptionStatus,
            readOnlyUntil: t.readOnlyUntil,
            anonymizationWarnedAt: t.anonymizationWarnedAt,
            anonymizationWarnedFor: t.anonymizationWarnedFor,
          },
          now,
        )
      : null;
  return {
    readOnlyUntil: t.readOnlyUntil,
    anonymizeOn,
    warnedAt: warnedForThisPeriod ? t.anonymizationWarnedAt : null,
    deletionRequestedAt: t.deletionRequestedAt,
    anonymizedAt: t.anonymizedAt,
    /** What the next 04:40 run would do now: "warn", "anonymize" or null. */
    nextStep: step?.kind ?? null,
  };
}

const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The console's check of a new salon's address (audit 8 T7): length and
 * shape, plus the reserved names it already refused. The platform words
 * ("kiraroom", "soporte") are not refused here: whether the platform may
 * use them for its own salons is the owner's pending decision.
 */
export function consoleSlugProblem(slug: string): WebAddressProblem | null {
  if (slug.length < WEB_ADDRESS_MIN) return "too_short";
  if (slug.length > WEB_ADDRESS_MAX) return "too_long";
  if (slugify(slug) !== slug) return "format";
  if (RESERVED_SUBDOMAINS.has(slug) || UUID_SHAPED.test(slug)) return "reserved";
  return null;
}

/** A unique column already taken (P2002) is a Spanish 409, not a 500 (audit 8 T22). */
export function rethrowUniqueConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    const target = String((err.meta as { target?: unknown } | undefined)?.target ?? "");
    if (target.includes("slug")) throw new ConflictException("Esa dirección web ya la usa otro salón.");
    if (target.includes("email")) throw new ConflictException("Ese email ya tiene una cuenta en KiraRoom.");
    throw new ConflictException("Ya hay otro registro con esos datos.");
  }
  throw err;
}

export const CONSOLE_EDIT_MESSAGES = {
  stripeOwnedStatus:
    "«Pago pendiente» y «Suspendido por impago» los pone Stripe según los cobros: no se pueden elegir a mano.",
  planInStripe:
    "Este salón paga su plan en Stripe: el plan se cambia desde su Facturación o desde Stripe, no desde aquí (el siguiente aviso de Stripe lo volvería a poner).",
  activeNeedsPlan: "Para dejarlo activo, elige un plan.",
  trialEnded:
    "La prueba de este salón ya ha terminado. Para volver a ponerlo en prueba, indica una nueva fecha de fin de prueba.",
  trialEndPast: "La nueva fecha de fin de prueba tiene que ser posterior a hoy.",
  cancelInStripe:
    "Este salón tiene una suscripción activa en Stripe: darlo de baja aquí no deja de cobrarle. Cancélala en Stripe (o pide a la dueña que lo haga desde Facturación).",
} as const;

/** Reactivating a salon whose owner asked to delete it (audit 8 T4). */
export function pendingDeletionMessage(requestedAt: Date): string {
  const day = requestedAt.toLocaleDateString("es-ES", { timeZone: "Europe/Madrid", day: "numeric", month: "long", year: "numeric" });
  return `La dueña pidió borrar este salón el ${day}. Reactivarlo anula esa petición: marca «Anular también el borrado pendiente» para confirmarlo.`;
}

/**
 * Entering read-only from the console (Suspender, or "De baja" in Editar):
 * the dates of an earlier read-only period must not count (audit 8 T4).
 * readOnlyUntil stays empty, as a fresh suspension has always left it:
 * when a suspension ends and its data goes is the pending decision on
 * suspend (T3).
 */
export const STALE_RETENTION_RESET = Object.freeze({
  readOnlyUntil: null,
  anonymizationWarnedAt: null,
  anonymizationWarnedFor: null,
});
