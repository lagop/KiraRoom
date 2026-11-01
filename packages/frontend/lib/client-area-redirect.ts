/**
 * Clients have no accounts on the salon's site any more: the sign-in, the
 * "Mi cuenta" area and its pages are gone. Their old addresses, bookmarked
 * or in emails already sent, lead to the salon's booking page instead of a
 * 404:
 *
 *   /sites/<slug>/account[/...]  -> /sites/<slug>
 *   /account[/...]               -> /   (on the salon's own domain or subdomain)
 *
 * A link to the old "new appointment" page keeps the service, professional
 * and day it carried (rebooking emails sent ?service=), so the booking form
 * still starts there. Nothing else in the query is carried over.
 */

const CARRIED = ["serviceId", "professionalId", "date"] as const;

export interface RetiredClientAreaRedirect {
  pathname: string;
  search: string;
}

/**
 * Where a retired client-area path goes, or null when the path is not one.
 * `onSalonHost` is true on a salon's subdomain or verified domain, where
 * the booking page is "/".
 */
export function retiredClientAreaRedirect(
  pathname: string,
  search: string,
  onSalonHost: boolean,
): RetiredClientAreaRedirect | null {
  let target: string | null = null;
  const sites = /^\/sites\/([^/]+)\/account(?:\/.*)?$/.exec(pathname);
  if (sites) {
    target = onSalonHost ? "/" : `/sites/${sites[1]}`;
  } else if (onSalonHost && /^\/account(?:\/.*)?$/.test(pathname)) {
    target = "/";
  }
  if (!target) return null;
  return { pathname: target, search: carriedQuery(search) };
}

/** The booking-form parameters of an old link, as a search string ("" or "?..."). */
export function carriedQuery(search: string): string {
  const from = new URLSearchParams(search);
  const to = new URLSearchParams();
  // The old area read ?service= as well as ?serviceId=.
  const service = from.get("serviceId") || from.get("service");
  for (const key of CARRIED) {
    const value = key === "serviceId" ? service : from.get(key);
    if (value) to.set(key, value);
  }
  const qs = to.toString();
  return qs ? `?${qs}` : "";
}
