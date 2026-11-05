/**
 * Review texts and rules the panel, the client's review page and the
 * salon's site share. Pure, tested in reviews.spec.ts. The backend has the
 * same rules (backend/src/reviews/review-rules.ts) and decides; these are
 * what people read.
 */

/** The only reasons a review can be rejected or hidden for (backend REVIEW_REJECTION_REASONS). */
export const REJECTION_REASONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "offensive", label: "Insultos o contenido ofensivo" },
  { key: "personal_data", label: "Datos personales" },
  { key: "off_topic", label: "No habla del servicio" },
  { key: "spam", label: "Spam o duplicada" },
];

export const LEGACY_REJECTION_REASON = "legacy_unspecified";

/** The box on the review page, unticked (backend PUBLISH_CONSENT_TEXT). */
export const PUBLISH_CONSENT_TEXT = "Pueden mostrar mi opinión en su web con mi nombre e inicial";

/** What the salon's site says about how reviews are handled. */
export function publicReviewRules(reasons: ReadonlyArray<string> = REJECTION_REASONS.map((r) => r.label)): {
  summary: string;
  reasons: string[];
} {
  return {
    summary:
      "Solo pueden opinar clientas con una cita completada. Publicamos todas las opiniones, positivas y negativas, salvo las que incumplen estas normas. La media cuenta todas las valoraciones salvo las retiradas por esas normas.",
    reasons: [...reasons],
  };
}

/** "por WhatsApp o por email" once the salon's WhatsApp review template is approved, else "por email". */
function channelWords(whatsapp?: string | null): string {
  return whatsapp === "APPROVED" ? "por WhatsApp o por email" : "por email";
}

/**
 * The reviews page headline. "After every appointment" only when the
 * requests are really going out: the add-on is active and switched on.
 * WhatsApp only once Meta approved the salon's review template.
 */
export function requestsHeadline(
  s: { addOnActive: boolean; autoRequestsEnabled: boolean; channels?: { whatsapp?: string | null } } | null,
): string {
  const by = channelWords(s?.channels?.whatsapp);
  if (s?.addOnActive && s.autoRequestsEnabled) {
    return `Después de cada cita, KiraRoom pide su opinión a la clienta ${by}. Tú moderas lo que llega; las aprobadas se ven en tu página de reservas.`;
  }
  if (s?.addOnActive) {
    return `Activa las peticiones y, después de cada cita, KiraRoom pedirá su opinión a la clienta ${by}. Tú moderas lo que llega; las aprobadas se ven en tu página de reservas.`;
  }
  return "Las opiniones de tus clientas, y cómo se muestran en tu página de reservas. Con el complemento «Reseñas tras la cita», KiraRoom les pide su opinión después de cada cita, por WhatsApp o por email.";
}

/** The WhatsApp channel of the review requests, as the settings show it. */
export interface WhatsAppChannelView {
  label: string;
  tone: "gray" | "amber" | "green" | "red";
  detail: string;
  /** "Enviar plantilla a Meta" is offered. */
  canSubmit: boolean;
  /** "Conectar WhatsApp" is offered. */
  needsConnection: boolean;
}

const WHO =
  "las clientas que pidieron los avisos de sus citas por WhatsApp";

/**
 * What the Reseñas settings say about WhatsApp, from the review template's
 * state (backend ReviewsService.getSettings channels.whatsapp). Until Meta
 * approves the template, every request goes by email. null for a server
 * that does not report it.
 */
export function whatsappChannelView(status: string | null | undefined): WhatsAppChannelView | null {
  if (!status) return null;
  const meanwhile = "Mientras, todas las peticiones van por email.";
  switch (status) {
    case "not_connected":
      return {
        label: "Sin conectar",
        tone: "gray",
        detail: `Conecta el WhatsApp de tu salón para pedir la opinión por WhatsApp a ${WHO}. ${meanwhile}`,
        canSubmit: false,
        needsConnection: true,
      };
    case "NOT_SUBMITTED":
      return {
        label: "Plantilla sin enviar",
        tone: "gray",
        detail: `Para escribir por WhatsApp a ${WHO}, Meta tiene que aprobar el mensaje (una plantilla de servicio, como la del recordatorio). Envíala y Meta la revisará, normalmente en unas horas. ${meanwhile}`,
        canSubmit: true,
        needsConnection: false,
      };
    case "PENDING":
    case "IN_APPEAL":
      return {
        label: "Plantilla en revisión",
        tone: "amber",
        detail: `Meta está revisando la plantilla, normalmente en unas horas. ${meanwhile}`,
        canSubmit: false,
        needsConnection: false,
      };
    case "APPROVED":
      return {
        label: "Activo",
        tone: "green",
        detail: `Plantilla aprobada por Meta: ${WHO} reciben la petición por WhatsApp; el resto, por email. Si un WhatsApp no se puede entregar, se envía por email.`,
        canSubmit: false,
        needsConnection: false,
      };
    case "REJECTED":
      return {
        label: "Plantilla rechazada",
        tone: "red",
        detail: `Meta ha rechazado la plantilla, así que no se piden opiniones por WhatsApp. Todas las peticiones van por email.`,
        canSubmit: false,
        needsConnection: false,
      };
    case "PAUSED":
    case "DISABLED":
      return {
        label: status === "PAUSED" ? "Plantilla en pausa" : "Plantilla desactivada",
        tone: "amber",
        detail: `Meta ha ${status === "PAUSED" ? "pausado" : "desactivado"} la plantilla. ${meanwhile}`,
        canSubmit: false,
        needsConnection: false,
      };
    case "unknown":
      return {
        label: "Sin datos de Meta",
        tone: "gray",
        detail: `No hemos podido consultar a Meta el estado de la plantilla. Vuelve a mirarlo más tarde; si no está aprobada, las peticiones van por email.`,
        canSubmit: false,
        needsConnection: false,
      };
    default:
      return {
        label: `Plantilla: ${status}`,
        tone: "amber",
        detail: meanwhile,
        canSubmit: false,
        needsConnection: false,
      };
  }
}

/** How a review shows on the salon's site, for the panel. */
export function publicVisibilityNote(r: { status: string; publishConsent?: string | null }): string | null {
  if (r.status === "pending") return null;
  if (r.publishConsent === "anonymised") return "Clienta anonimizada: solo cuenta su valoración, sin nombre ni comentario.";
  if (r.publishConsent === "declined") {
    return "No dio permiso para mostrarla en tu web: su valoración cuenta en la media, sin nombre ni comentario.";
  }
  if (r.status === "rejected") return "No se muestra ni cuenta en la media.";
  return null;
}

/** "Rechazada por Lucía Pérez el 3 nov. 2026: Datos personales". */
export function moderationLine(r: {
  status: string;
  moderationReason?: string | null;
  moderationReasonLabel?: string | null;
  moderatedByName?: string | null;
  moderatedAt?: string | null;
}): string | null {
  if (r.status === "rejected" && r.moderationReason === LEGACY_REJECTION_REASON) {
    return "Rechazada antes de que hubiera motivos: sin motivo (anterior). Revísala: apruébala o elige un motivo.";
  }
  if (r.status !== "rejected" && r.status !== "published") return null;
  if (!r.moderatedAt) return null;
  const when = new Date(r.moderatedAt).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
  const who = r.moderatedByName ? ` por ${r.moderatedByName}` : r.status === "published" ? " automáticamente" : "";
  if (r.status === "published") return `Aprobada${who} el ${when}`;
  const label = r.moderationReasonLabel ?? REJECTION_REASONS.find((x) => x.key === r.moderationReason)?.label ?? "";
  return `Rechazada${who} el ${when}${label ? `: ${label}` : ""}`;
}
