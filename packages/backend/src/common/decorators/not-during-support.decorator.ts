import { ForbiddenException, SetMetadata } from "@nestjs/common";

export const NOT_DURING_SUPPORT = "notDuringSupport";

/** The refusal's text: the panel shows it as is. */
export const SUPPORT_MODE_REFUSAL = "No disponible en modo soporte";

/**
 * What a support session (the platform owner inside a salon, audit 8 D1)
 * may not do: pay or change the plan, fiscal data and certificates,
 * passwords and panel access, two-step verification and sessions, client
 * exports and GDPR, deleting the salon. SupportScopeGuard refuses these
 * routes when the token carries the impersonation claim; everything else
 * (reading, the agenda, services, team, website) stays open to support.
 *
 * On a controller class it covers every route of it.
 */
export const NotDuringSupport = () => SetMetadata(NOT_DURING_SUPPORT, true);

export function supportModeException(): ForbiddenException {
  return new ForbiddenException({ code: "SUPPORT_MODE", message: SUPPORT_MODE_REFUSAL });
}
