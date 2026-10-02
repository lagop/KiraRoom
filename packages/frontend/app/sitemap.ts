import type { MetadataRoute } from "next";
import { appBaseUrl, canonicalUrl } from "@/lib/salon-seo";
import { fetchSitemapSalons } from "@/lib/public-site-server";

/**
 * sitemap.xml: every active salon's public page, at its canonical URL (its
 * own domain once that is live).
 *
 * Rendered per request rather than at build time: the build has no API to
 * ask, and a sitemap frozen empty at build would hide every salon until the
 * next deploy. Crawlers fetch it a few times a day; that is one API call each.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const salons = await fetchSitemapSalons();
  return salons.map((s) => ({
    url: canonicalUrl({ slug: s.slug, customDomain: s.customDomain }, appBaseUrl()),
    lastModified: new Date(s.updatedAt),
    changeFrequency: "weekly",
    priority: 0.8,
  }));
}
