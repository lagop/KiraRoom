import { redirect } from "next/navigation";
import { carriedQuery } from "@/lib/client-area-redirect";

/**
 * Clients no longer have accounts. The middleware sends the old client-area
 * addresses to the booking page (lib/client-area-redirect.ts); this page
 * does the same if a request ever reaches it, so a bookmark never 404s.
 */
export default function RetiredClientArea({
  params,
  searchParams,
}: {
  params: { salonName: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (typeof value === "string") query.set(key, value);
  }
  redirect(`/sites/${encodeURIComponent(params.salonName)}${carriedQuery(query.toString())}`);
}
