import { fetchPublicSalonPage } from "@/lib/public-site-server";
import { canonicalUrl, salonRobotsTxt } from "@/lib/salon-seo";

/**
 * robots.txt on the salon's own host (its domain or subdomain): the
 * middleware rewrites /robots.txt there to this route. It used to get the
 * platform's, which pointed at the app's sitemap of every salon.
 */
export const revalidate = 300;

export async function GET(_req: Request, { params }: { params: { salonName: string } }) {
  const page = await fetchPublicSalonPage(params.salonName);
  if (!page) return new Response("Not found", { status: 404 });
  return new Response(salonRobotsTxt(canonicalUrl(page)), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
