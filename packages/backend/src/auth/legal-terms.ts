/**
 * The version of the Terms of Service (which include the art. 28 GDPR data
 * processing agreement) and the Privacy Policy that a salon accepts on
 * signing up or accepting an invite. It is the date the terms page shows as
 * "Última actualización" (packages/frontend/app/legal/terms/page.tsx); a
 * spec fails when the two drift apart, so changing the terms means changing
 * this too, and every acceptance from then on records the new version.
 */
export const TERMS_VERSION = "2026-11-04";

/** The same date as the terms page writes it. */
export const TERMS_LAST_UPDATED_LABEL = "4 de noviembre de 2026";

/**
 * "signup" and "invite" when the account is created; "login_prompt" when an
 * owner accepts a newer version in the panel (D3: salons from before the
 * acceptance was recorded, and every later version bump).
 */
export type LegalAcceptanceSource = "signup" | "invite" | "login_prompt";
