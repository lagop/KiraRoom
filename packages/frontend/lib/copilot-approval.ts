/**
 * What an approval card shows (Copilot audit M9). The card used to guess
 * from the message's age: after 5 minutes every card said «Acción
 * caducada», executed ones included; before that an executed one showed
 * «Aprobar» again and clicking it gave «approval_not_pending:executed».
 * The coupon code was only in the JSON, and a permission refusal showed as
 * «Acción cancelada» with a tick.
 */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "executed";

export type ApprovalCardState =
  | "pending" // waiting for Aprobar / Cancelar
  | "running" // approved, being carried out
  | "done"
  | "failed" // approved, but it went wrong
  | "forbidden" // no permission when it ran
  | "cancelled"
  | "expired";

export interface ApprovalInfo {
  status: ApprovalStatus;
  expiresAt: string;
  result?: unknown;
}

function resultObject(result: unknown): Record<string, unknown> {
  return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
}

export function approvalCardState(approval: ApprovalInfo, now: number = Date.now()): ApprovalCardState {
  const r = resultObject(approval.result);
  switch (approval.status) {
    case "pending":
      return new Date(approval.expiresAt).getTime() <= now ? "expired" : "pending";
    case "approved":
      return "running";
    case "executed":
      return r.error ? "failed" : "done";
    case "rejected":
      if (r.error === "forbidden") return "forbidden";
      return r.error ? "failed" : "cancelled";
    case "expired":
      return "expired";
  }
}

/** Plain lines about the result: the tool's own message, a coupon code. */
export function approvalResultLines(result: unknown): string[] {
  const r = resultObject(result);
  const lines: string[] = [];
  if (typeof r.code === "string" && r.code) {
    const until = typeof r.validUntil === "string" ? ` (válido hasta el ${spanishDay(r.validUntil)})` : "";
    lines.push(`Código: ${r.code}${until}`);
  }
  if (typeof r.message === "string" && r.message.trim()) lines.push(r.message.trim());
  return lines;
}

function spanishDay(isoDay: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDay);
  return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : isoDay;
}

/** Spanish names for the statuses on the usage page. */
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  executed: "Hechas",
  approved: "En curso",
  rejected: "Canceladas o sin permiso",
  expired: "Caducadas",
  pending: "Pendientes",
};

/**
 * The card's state from an error on Aprobar/Cancelar: the server says the
 * action is no longer pending (another tab, a double click, it expired).
 */
export function stateFromResolveError(message: string, status?: number): ApprovalCardState | null {
  if (status === 410 || message.includes("approval_expired") || message.includes("approval_not_pending:expired")) {
    return "expired";
  }
  const m = /approval_not_pending:(\w+)/.exec(message);
  if (!m) return null;
  switch (m[1]) {
    case "executed":
      return "done";
    case "approved":
      return "running";
    case "rejected":
      return "cancelled";
    default:
      return null;
  }
}
