import { ForbiddenException, SetMetadata } from "@nestjs/common";

/**
 * Audit 8 D15: with SAAS_OWNER_2FA_REQUIRED=true, a platform owner without
 * two-step verification can only set it up: every other signed-in route
 * answers 403 SAAS_OWNER_2FA_REQUIRED until she does. Off by default.
 * The seed script's recovery (scripts/seed-saas-owner.ts) clears 2FA; with
 * the flag on, the recovered owner signs in and is sent to set it up again.
 */
export const SAAS_OWNER_2FA_REQUIRED_ENV = "SAAS_OWNER_2FA_REQUIRED";

export function saasOwnerTwoFactorRequired(
  get: (key: string) => string | undefined | null = (key) => process.env[key],
): boolean {
  return String(get(SAAS_OWNER_2FA_REQUIRED_ENV) ?? "").trim().toLowerCase() === "true";
}

export const ALLOW_WITHOUT_TWO_FACTOR = "allowWithoutTwoFactor";

/** A route a platform owner without 2FA may still use: her profile, setting 2FA up, signing out. */
export const AllowWithoutTwoFactor = () => SetMetadata(ALLOW_WITHOUT_TWO_FACTOR, true);

export const SAAS_OWNER_2FA_SETUP_PATH = "/saas/seguridad";

export function saasOwnerTwoFactorException(): ForbiddenException {
  return new ForbiddenException({
    code: "SAAS_OWNER_2FA_REQUIRED",
    message: "Activa la verificación en dos pasos para usar la consola.",
    setupUrl: SAAS_OWNER_2FA_SETUP_PATH,
  });
}
