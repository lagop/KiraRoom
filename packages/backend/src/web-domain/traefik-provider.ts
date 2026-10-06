/**
 * Traefik's dynamic configuration for the salons' hosts, served to Traefik's
 * HTTP provider (providers.http.endpoint) so certificates follow the data:
 *
 *   - one router per verified custom domain (reservas.misalon.com), with a
 *     certificate Traefik requests from Let's Encrypt itself (TLS challenge);
 *   - one router for every <slug>.<base> host, with the wildcard certificate
 *     for *.<base> obtained through the DNS challenge (Hostinger's DNS API),
 *     once a resolver for it is configured.
 *
 * Only verified domains are listed: a host nobody verified never makes
 * Traefik ask Let's Encrypt for a certificate, so random Host headers cannot
 * burn the rate limits. See docs/custom-domains.md.
 */

export interface TraefikProviderSettings {
  /** Traefik service the routers send to: the frontend's, from its Docker labels. */
  service: string;
  entryPoint: string;
  /** Resolver for per-domain certificates (TLS / HTTP challenge). */
  certResolver: string;
  /** Resolver that can do the DNS challenge for the wildcard; empty = no wildcard router. */
  dnsCertResolver: string;
  /** "kiraroom.net"; empty = no subdomain router. */
  subdomainBase: string;
  /** Traefik's major version: the HostRegexp syntax changed in v3. */
  traefikMajor: number;
}

type Router = {
  rule: string;
  entryPoints: string[];
  service: string;
  priority?: number;
  tls: { certResolver: string; domains?: Array<{ main: string; sans?: string[] }> };
};

/** Priority of the wildcard router: below the app/api routers (their rule length) and below the apex redirector. */
export const SUBDOMAIN_ROUTER_PRIORITY = 2;

export function traefikDynamicConfig(
  domains: string[],
  s: TraefikProviderSettings,
): { http?: { routers: Record<string, Router> } } {
  const routers: Record<string, Router> = {};

  for (const domain of [...new Set(domains)].sort()) {
    // Router names allow letters, digits, - and _ only.
    routers[`kiraroom-domain-${domain.replace(/[^a-z0-9-]/g, "_")}`] = {
      rule: `Host(\`${domain}\`)`,
      entryPoints: [s.entryPoint],
      service: s.service,
      tls: { certResolver: s.certResolver },
    };
  }

  if (s.subdomainBase && s.dnsCertResolver) {
    const escaped = s.subdomainBase.replace(/\./g, "\\.");
    routers["kiraroom-salon-subdomains"] = {
      rule:
        s.traefikMajor >= 3
          ? `HostRegexp(\`^[a-z0-9-]+\\.${escaped}$\`)`
          : `HostRegexp(\`{salon:[a-z0-9-]+}.${s.subdomainBase}\`)`,
      entryPoints: [s.entryPoint],
      service: s.service,
      // Below app.<base> / api.<base> (whose priority is their rule's length)
      // and the apex/www redirector, so those keep their own routers.
      priority: SUBDOMAIN_ROUTER_PRIORITY,
      tls: {
        certResolver: s.dnsCertResolver,
        domains: [{ main: s.subdomainBase, sans: [`*.${s.subdomainBase}`] }],
      },
    };
  }

  // Traefik rejects an empty "routers" ("routers cannot be a standalone
  // element"); an empty configuration is valid.
  return Object.keys(routers).length ? { http: { routers } } : {};
}
