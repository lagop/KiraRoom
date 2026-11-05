import type { PublicSalonPage } from "./salon-seo";
import type { SalonLegal } from "./salon-legal";

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

/**
 * The salon's page data, or null when there is no such salon, or it is gone
 * (410: past its read-only period). The middleware answers 410 itself for a
 * gone salon (salonGone); this is the fallback if it could not ask.
 */
export async function fetchPublicSalonPage(slug: string): Promise<PublicSalonPage | null> {
  const res = await fetch(`${SERVER_API_URL}/public-site/page/${encodeURIComponent(slug)}`, {
    headers: { accept: "application/json" },
    next: { revalidate: SALON_PAGE_REVALIDATE_SECONDS },
  });
  if (res.status === 404 || res.status === 410) return null;
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
  subdomainHost?: string | null;
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

/** The salon's public reviews (GET /public/reviews/tenant/:id). */
export interface PublicReviews {
  /** Every answered rating except those rejected for breaking the rules. */
  averageRating: number;
  total: number;
  /** Approved reviews whose author agreed to show them, with first name and initial. */
  reviews: Array<{ id: string; rating: number; comment: string | null; author: string; date: string }>;
  /** The only reasons a review is not published (absent from older servers). */
  rejectionReasons?: string[];
}

/**
 * The reviews, fetched with the page so they are in its HTML (crawlers saw
 * none, and the block pushed the footer down once it loaded). Undefined when
 * the API did not answer: the page then asks for them from the browser, as
 * before, rather than keep "no reviews" for the whole cache window.
 */
export async function fetchPublicReviews(tenantId: string): Promise<PublicReviews | undefined> {
  try {
    const res = await fetch(`${SERVER_API_URL}/public/reviews/tenant/${encodeURIComponent(tenantId)}`, {
      headers: { accept: "application/json" },
      next: { revalidate: SALON_PAGE_REVALIDATE_SECONDS },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as PublicReviews;
  } catch {
    return undefined;
  }
}

/**
 * Who runs the salon, for its privacy page and aviso legal; null when there
 * is no such salon or it is gone.
 */
export async function fetchSalonLegal(slug: string): Promise<SalonLegal | null> {
  const res = await fetch(`${SERVER_API_URL}/public-site/legal/${encodeURIComponent(slug)}`, {
    headers: { accept: "application/json" },
    next: { revalidate: SALON_PAGE_REVALIDATE_SECONDS },
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`public-site/legal/${slug} answered ${res.status}`);
  return (await res.json()) as SalonLegal;
}
