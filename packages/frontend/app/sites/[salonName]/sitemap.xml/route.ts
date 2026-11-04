import { fetchPublicSalonPage } from "@/lib/public-site-server";
import { canonicalUrl, salonSitemapXml } from "@/lib/salon-seo";

/**
 * sitemap.xml on the salon's own host: only its canonical page (the
 * middleware rewrites /sitemap.xml there to this route). It used to be the
 * platform's, listing every KiraRoom salon in each salon's Search Console.
 */
export const revalidate = 300;

export async function GET(_req: Request, { params }: { params: { salonName: string } }) {
  const page = await fetchPublicSalonPage(params.salonName);
  if (!page) return new Response("Not found", { status: 404 });
  return new Response(salonSitemapXml(page, canonicalUrl(page)), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
