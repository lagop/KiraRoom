import { salonPublicUrl } from "@kira/shared";

const truthy = (v: string | undefined) => ["1", "true"].includes((v ?? "").trim().toLowerCase());

/**
 * The address a client should get for a salon's page, from the server's
 * configuration (see salonPublicUrl): its own domain when verified and
 * CUSTOM_DOMAINS_TLS_READY is on, its subdomain when SALON_SUBDOMAINS_READY
 * is on, else /sites/<slug> on the app.
 */
export function salonPublicUrlFromEnv(
  slug: string,
  customDomain: { domain: string; verifiedAt: Date | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const served = !!customDomain?.verifiedAt && truthy(env.CUSTOM_DOMAINS_TLS_READY);
  return salonPublicUrl({
    slug,
    appBaseUrl: env.APP_BASE_URL || env.FRONTEND_URL || "http://localhost:3000",
    subdomainBase: env.SALON_SUBDOMAIN_BASE,
    subdomainsReady: truthy(env.SALON_SUBDOMAINS_READY),
    customDomain: served ? customDomain!.domain : null,
  });
}
