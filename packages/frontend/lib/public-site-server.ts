import type { PublicSalonPage } from "./salon-seo";

/**
 * Server-side reads of the public site API, for server components, the
 * sitemap and generateMetadata. Not for the browser: it prefers
 * INTERNAL_API_URL (the backend on the Docker network) so a render does not
 * go out through the public proxy and back in.
 */
const SERVER_API_URL = (
  process.env.INTERNAL_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:3001/api/v1"
).replace(/\/+$/, "");

/**
 * How long a rendered salon page is reused before the API is asked again.
 * A price change shows up within this window. Short enough for that, long
 * enough that a crawler walking every salon does not turn into one API call
 * per hit (all server renders share one rate-limit bucket at the API).
 */
export const SALON_PAGE_REVALIDATE_SECONDS = 300;

/** The salon's page data, or null when there is no such salon. */
export async function fetchPublicSalonPage(slug: string): Promise<PublicSalonPage | null> {
  const res = await fetch(`${SERVER_API_URL}/public-site/page/${encodeURIComponent(slug)}`, {
    headers: { accept: "application/json" },
    next: { revalidate: SALON_PAGE_REVALIDATE_SECONDS },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    // Thrown, not turned into "not found": a 404 would tell search engines
    // the salon is gone because the API had a bad minute.
    throw new Error(`public-site/page/${slug} answered ${res.status}`);
  }
  return (await res.json()) as PublicSalonPage;
}

export interface SitemapSalon {
  slug: string;
  updatedAt: string;
  customDomain: string | null;
}

/** Salons to list in sitemap.xml; empty when the API cannot be reached. */
export async function fetchSitemapSalons(): Promise<SitemapSalon[]> {
  try {
    const res = await fetch(`${SERVER_API_URL}/public-site/sitemap`, {
      headers: { accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    return (await res.json()) as SitemapSalon[];
  } catch {
    return [];
  }
}
