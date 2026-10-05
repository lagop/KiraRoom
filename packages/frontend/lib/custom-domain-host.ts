/**
 * Serving a salon's page on the salon's own domain.
 *
 * A request for reservas.misalon.com reaches the same Next server as the
 * app. The middleware asks the API which salon verified that host and
 * rewrites the path under /sites/<slug>, so the visitor stays on their URL
 * and sees the salon's page. These are the decisions it makes, kept pure so
 * lib/custom-domain-host.spec.ts can check them without a server.
 *
 * Every salon also has a free subdomain, <slug>.<SALON_SUBDOMAIN_BASE>
 * (salon-lucia.kiraroom.net). That host names the salon itself, so it needs
 * no lookup; see salonSlugForSubdomain and subdomainRedirectFor.
 */
import { isSalonSubdomainSlug, normaliseSubdomainBase, slugFromSalonSubdomain } from "@kira/shared";

/** Host header without port, lower-case, no trailing dot. */
export function bareHost(hostHeader: string | null | undefined): string {
  if (!hostHeader) return "";
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    // IPv6 literal: "[::1]:3000"
    const end = host.indexOf("]");
    return end > 0 ? host.slice(0, end + 1) : host;
  }
  host = host.replace(/:\d+$/, "");
  return host.replace(/\.$/, "");
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Hosts that are the platform itself and never a salon's domain: the app,
 * kiraroom.net and its subdomains, local development, bare IPs, and any
 * extra host the deployment lists. Only something that looks like a real
 * domain and is none of these is worth a lookup.
 */
export function isPlatformHost(host: string, extraPlatformHosts: string[] = []): boolean {
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "kiraroom.net" || host.endsWith(".kiraroom.net")) return true;
  if (extraPlatformHosts.includes(host)) return true;
  // IPv4 / IPv6 literals and anything that is not a well-formed domain.
  if (!HOST_RE.test(host)) return true;
  return false;
}

/** Hosts from a comma-separated env value plus the app URL's own host. */
export function platformHostsFrom(list: string | undefined, appUrl: string | undefined): string[] {
  const hosts = (list ?? "")
    .split(",")
    .map((h) => bareHost(h))
    .filter(Boolean);
  if (appUrl) {
    try {
      hosts.push(new URL(appUrl).hostname.toLowerCase());
    } catch {
      /* not a URL: nothing to add */
    }
  }
  return hosts;
}

/**
 * Where a path on the salon's domain lives in the app.
 *
 *   /                 -> /sites/<slug>
 *   /account          -> /sites/<slug>/account
 *   /sites/<slug>/... -> unchanged (the page's own links use this form)
 *
 * Returns null when no rewrite is needed. A path under ANOTHER salon's
 * /sites/ is rewritten under this salon (and 404s there): one salon's
 * domain must not serve a different salon's page.
 */
export function rewritePathFor(pathname: string, slug: string): string | null {
  const own = `/sites/${slug}`;
  if (pathname === own || pathname.startsWith(`${own}/`)) return null;
  if (pathname === "/" || pathname === "") return own;
  return `${own}${pathname}`;
}

/** The salon a <slug>.<base> host names, or null. */
export function salonSlugForSubdomain(host: string, base: string | undefined): string | null {
  return slugFromSalonSubdomain(host, base);
}

/**
 * Once subdomains are live, the public page on the app host moves to the
 * salon's subdomain: app.kiraroom.net/sites/salon-lucia ->
 * https://salon-lucia.kiraroom.net/ (permanent, so search engines move the
 * page too). Only the public page: the client area keeps its URL, because a
 * signed-in client's session lives in the browser storage of the host they
 * signed in on, and moving them would sign them out. Ids (/sites/<uuid>)
 * and slugs that cannot be a subdomain stay where they are.
 */
export function subdomainRedirectFor(
  host: string,
  pathname: string,
  appHosts: string[],
  base: string | undefined,
  ready: boolean,
): string | null {
  const b = normaliseSubdomainBase(base);
  if (!ready || !b || !appHosts.includes(host)) return null;
  const match = /^\/sites\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }
  if (!isSalonSubdomainSlug(slug)) return null;
  return `https://${slug}.${b}/`;
}
