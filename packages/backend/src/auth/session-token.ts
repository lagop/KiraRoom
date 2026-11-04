/**
 * What a session token says it is (audit 8, C11).
 *
 * Several tokens are signed with JWT_SECRET: the session's access token, the
 * 5-minute token between password and code (2FA), the 60-second token the
 * console hands out to enter a salon as support. Only the first is a session.
 * Before, JwtStrategy accepted any of them as an access token; now an access
 * token says `typ: "access"` and nothing else is taken as one. A refresh token
 * (signed with JWT_REFRESH_SECRET) says `typ: "refresh"`.
 */
export const ACCESS_TOKEN_TYPE = "access";
export const REFRESH_TOKEN_TYPE = "refresh";

/** Claims that only purpose-specific tokens carry. */
function hasPurpose(payload: Record<string, unknown>): boolean {
  return payload.aud !== undefined || payload.purpose !== undefined || payload.impersonate !== undefined;
}

/** A token that may be used as the session on an API request. */
export function isAccessTokenPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return p.typ === ACCESS_TOKEN_TYPE && !hasPurpose(p);
}

/**
 * A token that may renew a session. Refresh tokens minted before `typ`
 * existed (up to 7 days old at deploy) carry none and still renew once,
 * into a typed pair; any other type, or a purpose, is refused.
 */
export function isRefreshTokenPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (p.typ === undefined || p.typ === REFRESH_TOKEN_TYPE) && !hasPurpose(p);
}

/**
 * Hard cap of a support session (audit 8, C2): 2 hours from the moment the
 * platform owner enters the salon. The access and refresh tokens never live
 * past it, and a refresh after it is refused.
 */
export const SUPPORT_SESSION_MAX_SECONDS = 2 * 60 * 60;

/** Impersonation claims carried by every token of a support session. */
export interface SupportSessionClaims {
  /** The saas_owner who entered the salon. */
  impersonatedBy: string;
  /** The one-shot token's jti: ties every row of the session together. */
  impersonationId: string;
  impersonatedTenantId: string;
  /** Unix seconds: when the session ends, whatever happens. */
  impersonationEndsAt: number;
  /** The saas_owner's tokenVersion at entry: logout everywhere or a new password ends it (C13). */
  impersonatorTv: number;
}

/** The support claims of a decoded token, or null when it has none or they are incomplete. */
export function supportClaims(payload: Record<string, any> | null | undefined): SupportSessionClaims | null {
  if (!payload?.impersonatedBy) return null;
  if (
    typeof payload.impersonationId !== "string" ||
    typeof payload.impersonatedTenantId !== "string" ||
    typeof payload.impersonationEndsAt !== "number" ||
    typeof payload.impersonatorTv !== "number"
  ) {
    return null;
  }
  return {
    impersonatedBy: payload.impersonatedBy,
    impersonationId: payload.impersonationId,
    impersonatedTenantId: payload.impersonatedTenantId,
    impersonationEndsAt: payload.impersonationEndsAt,
    impersonatorTv: payload.impersonatorTv,
  };
}

/** C17: the reason for entering a salon as support. Required, kept short. */
export const SUPPORT_REASON_MIN = 5;
export const SUPPORT_REASON_MAX = 200;

/** Why this reason cannot be used, or null when it can. */
export function supportReasonProblem(reason: unknown): string | null {
  if (typeof reason !== "string" || reason.trim().length < SUPPORT_REASON_MIN) {
    return `Escribe el motivo de la sesión de soporte (mínimo ${SUPPORT_REASON_MIN} caracteres).`;
  }
  if (reason.trim().length > SUPPORT_REASON_MAX) {
    return `El motivo no puede pasar de ${SUPPORT_REASON_MAX} caracteres.`;
  }
  return null;
}
