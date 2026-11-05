/**
 * Entering a salon as support from the console (audit 8, C10/C17). Pure
 * helpers, shared by the console and the specs.
 */

/** Same limits as the backend (auth/session-token.ts). */
export const SUPPORT_REASON_MIN = 5;
export const SUPPORT_REASON_MAX = 200;

export function supportReasonProblem(reason: string): string | null {
  const r = reason.trim();
  if (r.length < SUPPORT_REASON_MIN) {
    return `Escribe el motivo de la sesión de soporte (mínimo ${SUPPORT_REASON_MIN} caracteres).`;
  }
  if (r.length > SUPPORT_REASON_MAX) return `El motivo no puede pasar de ${SUPPORT_REASON_MAX} caracteres.`;
  return null;
}

/**
 * The address the new tab opens. The one-shot token goes in the fragment
 * (#), never the query: a fragment is not sent to the server, so it stays out
 * of the web server's logs and the Referer. The salon's name goes along so the
 * loading screen and the banner can say which salon it is.
 */
export function supportEntryUrl(p: { token: string; tenantId: string; tenantName: string; ownerName?: string }): string {
  const hash = new URLSearchParams({
    support: p.token,
    tenant: p.tenantId,
    name: p.tenantName,
    ...(p.ownerName ? { owner: p.ownerName } : {}),
  });
  return `/login#${hash.toString()}`;
}

/**
 * How long a support session lasted, for Ajustes > Seguridad (audit 8 D2):
 * minutes under an hour, hours and minutes above. Null when the session
 * did not end with "Salir del modo soporte" (still open, or ended at its cap).
 */
export function supportSessionDuration(
  seconds: number | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return t("supportAccess.less_than_minute");
  if (minutes < 60) return t("supportAccess.minutes", { n: minutes });
  return t("supportAccess.hours_minutes", { h: Math.floor(minutes / 60), m: minutes % 60 });
}
