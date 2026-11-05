import { ForbiddenException } from "@nestjs/common";

/**
 * Audit 8 D2: the owner's "Permitir que soporte de KiraRoom entre en mi
 * panel". Off, the console cannot open a support session (launch and
 * redeem both check) and one already open ends on its next request.
 */
export const SUPPORT_ACCESS_OFF_CODE = "SUPPORT_ACCESS_OFF";
export const SUPPORT_ACCESS_OFF_MESSAGE =
  "Este salón no permite que soporte de KiraRoom entre en su panel. Quien lo gestiona puede activarlo en Ajustes > Seguridad.";

/** Whether the salon lets support in: only an explicit false says no. */
export function supportAccessAllowed(tenant: { allowSupportAccess?: boolean | null } | null | undefined): boolean {
  return tenant?.allowSupportAccess !== false;
}

export function supportAccessOffException(): ForbiddenException {
  return new ForbiddenException({ code: SUPPORT_ACCESS_OFF_CODE, message: SUPPORT_ACCESS_OFF_MESSAGE });
}

/** Where the owner turns it off; the email links here. */
export const SUPPORT_ACCESS_SETTINGS_PATH = "/dashboard/settings/seguridad#soporte";

export const SUPPORT_SESSION_START_ACTION = "saas.impersonate";
export const SUPPORT_SESSION_END_ACTION = "saas.impersonate.end";

export type SupportSessionStatus = "active" | "ended" | "expired";

export interface SupportSessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  /** Seconds, when the session was ended with "Salir del modo soporte". */
  durationSeconds: number | null;
  reason: string | null;
  supportName: string | null;
  status: SupportSessionStatus;
}

interface AuditRow {
  id: string;
  createdAt: Date;
  actorId: string;
  action: string;
  metadata: unknown;
}

function meta(row: AuditRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {};
}

/**
 * The salon's support sessions, newest first, from the audit log: a
 * `saas.impersonate` row starts one, the `saas.impersonate.end` row with the
 * same impersonationId ends it. Without an end row it is active until its
 * cap (endsAt) and "expired" after.
 */
export function supportSessionsFromAudit(
  rows: AuditRow[],
  names: Map<string, string>,
  now: Date = new Date(),
): SupportSessionRow[] {
  const ends = new Map<string, Date>();
  for (const row of rows) {
    if (row.action !== SUPPORT_SESSION_END_ACTION) continue;
    const id = meta(row).impersonationId;
    if (typeof id !== "string") continue;
    const seen = ends.get(id);
    if (!seen || row.createdAt < seen) ends.set(id, row.createdAt);
  }
  const sessions: SupportSessionRow[] = [];
  for (const row of rows) {
    if (row.action !== SUPPORT_SESSION_START_ACTION) continue;
    const m = meta(row);
    const id = typeof m.impersonationId === "string" ? m.impersonationId : row.id;
    const endedAt = ends.get(id) ?? null;
    const cap = typeof m.endsAt === "string" ? new Date(m.endsAt) : null;
    const status: SupportSessionStatus = endedAt
      ? "ended"
      : cap && !Number.isNaN(cap.getTime()) && cap.getTime() > now.getTime()
        ? "active"
        : "expired";
    sessions.push({
      id,
      startedAt: row.createdAt.toISOString(),
      endedAt: endedAt ? endedAt.toISOString() : null,
      durationSeconds: endedAt ? Math.max(0, Math.round((endedAt.getTime() - row.createdAt.getTime()) / 1000)) : null,
      reason: typeof m.reason === "string" ? m.reason : null,
      supportName: names.get(row.actorId) ?? null,
      status,
    });
  }
  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
