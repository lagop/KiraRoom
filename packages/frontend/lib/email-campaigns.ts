import type { CampaignExclusionReason, CampaignStatus, EmailCampaign } from "./api";
import { salonInstant } from "../components/Calendar/salon-time";

/**
 * What the email campaigns page shows and allows. Kept apart from the page
 * so the rules are tested (email-campaigns.spec.ts): a re-engagement
 * campaign never offers a one-shot send, a sent campaign is archived (never
 * deleted), a scheduled one can be taken back to draft, and the schedule is
 * the salon's clock, not the browser's.
 */

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Borrador",
  active: "Activa",
  scheduled: "Programada",
  sending: "Enviando",
  sent: "Enviada",
  cancelled: "Cancelada",
  failed: "Fallida",
};

export function campaignStatusLabel(status: string): string {
  return CAMPAIGN_STATUS_LABELS[status as CampaignStatus] ?? status;
}

/** The buttons a campaign card shows. */
export interface CampaignActions {
  sendToAll: boolean;
  recipients: boolean;
  edit: boolean;
  schedule: boolean;
  sendNow: boolean;
  unschedule: boolean;
  activate: boolean;
  deactivate: boolean;
  retryFailed: boolean;
  archive: boolean;
  unarchive: boolean;
  delete: boolean;
}

type CampaignLike = Pick<EmailCampaign, "status" | "campaignType" | "emailsSent"> &
  Partial<Pick<EmailCampaign, "archivedAt" | "failedCount">>;

export function campaignActions(c: CampaignLike): CampaignActions {
  const reengagement = c.campaignType === "reengagement";
  const archived = !!c.archivedAt;
  const draft = c.status === "draft" && !archived;
  // A campaign that emailed anyone is archived, not deleted: its recipient
  // rows carry the unsubscribe links already in the clients' inboxes.
  const emailed = (c.emailsSent ?? 0) > 0;
  return {
    // One-shot sends are for one-shot campaigns: a re-engagement campaign
    // writes to each client when she has been away long enough.
    sendToAll: draft && !reengagement,
    recipients: draft && !reengagement,
    edit: draft,
    schedule: draft && !reengagement,
    sendNow: draft && !reengagement,
    unschedule: c.status === "scheduled",
    activate: draft && reengagement,
    deactivate: c.status === "active" && reengagement,
    retryFailed: c.status === "sent" && (c.failedCount ?? 0) > 0 && !archived,
    archive: !archived && (["sent", "failed", "cancelled"].includes(c.status) || (c.status === "draft" && emailed)),
    unarchive: archived,
    delete: !archived && !emailed && ["draft", "failed", "cancelled"].includes(c.status),
  };
}

/** "" from an optional field is "not given": the server wants it left out. */
export function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The instant the salon's clock reads `time` on `day`: what the schedule means. */
export function scheduledInstantIso(day: string, time: string, timeZone: string): string {
  return salonInstant(day, time, timeZone).toISOString();
}

/** "lunes, 3 de noviembre de 2026, 10:30", on the salon's clock. */
export function formatSalonDateTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

export const EXCLUSION_LABELS: Record<CampaignExclusionReason, string> = {
  no_visit: "Sin visitas",
  refused: "No quiere promociones",
  suppressed: "Dada de baja o rebote",
  no_email: "Sin email",
  inactive: "No activa",
};

const EXCLUSION_PHRASES: Record<CampaignExclusionReason, [string, string]> = {
  no_visit: ["no ha venido nunca (sin visitas completadas)", "no han venido nunca (sin visitas completadas)"],
  refused: ["no quiere recibir promociones", "no quieren recibir promociones"],
  suppressed: ["se dio de baja, tuvo un rebote o marcó un email como spam", "se dieron de baja, tuvieron un rebote o marcaron un email como spam"],
  no_email: ["no tiene email", "no tienen email"],
  inactive: ["no está activa", "no están activas"],
};

/**
 * "12 clientas no pueden recibir campañas: 8 no han venido nunca (...), 4 no
 * quieren recibir promociones." Null when nobody is left out.
 */
export function exclusionSummary(excluded: Partial<Record<CampaignExclusionReason, number>>): string | null {
  const order: CampaignExclusionReason[] = ["no_visit", "refused", "suppressed", "no_email", "inactive"];
  const parts = order
    .filter((reason) => (excluded[reason] ?? 0) > 0)
    .map((reason) => {
      const n = excluded[reason] as number;
      return `${n} ${EXCLUSION_PHRASES[reason][n === 1 ? 0 : 1]}`;
    });
  if (parts.length === 0) return null;
  const total = order.reduce((sum, r) => sum + (excluded[r] ?? 0), 0);
  const head = total === 1 ? "1 clienta no puede recibir campañas" : `${total} clientas no pueden recibir campañas`;
  return `${head}: ${parts.join(", ")}.`;
}

/** What the confirm dialog says before sending: exactly what will happen. */
export function sendConfirmText(action: "send" | "sendAll", pending: number): string {
  if (action === "sendAll") {
    return (
      "Se añadirán como destinatarias todas las clientas con email que han venido al menos una vez, " +
      "aceptan promociones y no se han dado de baja, y se empezará a enviar ahora. " +
      "Los emails salen poco a poco; el avance se ve en la tarjeta."
    );
  }
  const who = pending === 1 ? "la destinataria que tiene añadida" : `las ${pending} destinatarias que tiene añadidas`;
  return (
    `Se empezará a enviar ahora a ${who}. Si alguna ya no puede recibirla (se dio de baja o dejó de ser clienta), ` +
    "se salta. Los emails salen poco a poco; el avance se ve en la tarjeta."
  );
}

/** The card's progress line while sending, and its result after. */
export function campaignProgress(c: Pick<EmailCampaign, "status" | "emailsSent" | "totalRecipients"> & Partial<Pick<EmailCampaign, "pendingCount" | "failedCount" | "lastError">>): string | null {
  const failed = c.failedCount ?? 0;
  if (c.status === "sending") {
    return `Enviando: ${c.emailsSent} de ${c.totalRecipients}` + (failed > 0 ? `, ${failed} fallidos` : "");
  }
  if (c.status === "sent") {
    if (c.lastError) return c.lastError;
    return failed > 0 ? `${failed} ${failed === 1 ? "email no se pudo enviar" : "emails no se pudieron enviar"}` : null;
  }
  return c.lastError ?? null;
}

/** Whether the server refused because the plan does not include campaigns. */
export function isPlanBlocked(error: unknown): boolean {
  // Duck-typed (ApiError carries status and code) so this file stays free of the API client.
  const e = error as { status?: unknown; code?: unknown } | null;
  return !!e && typeof e === "object" && e.status === 403 && e.code === "FEATURE_NOT_IN_PLAN";
}

/** A message for a toast: the server's own when it sent one. */
export function errorMessage(error: unknown, fallback = "Algo ha fallado. Inténtalo de nuevo."): string {
  if (isPlanBlocked(error)) return "Tu plan no incluye esta función. Puedes cambiar de plan en Facturación.";
  return error instanceof Error && error.message ? error.message : fallback;
}
