import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  bareHost,
  isPlatformHost,
  platformHostsFrom,
  rewritePathFor,
} from "./lib/custom-domain-host";

// All authentication for `/saas/*` is enforced server-side by the NestJS
// `SaasOwnerGuard` on the corresponding API endpoints. This middleware is
// intentionally permissive for SaaS routes because we cannot read JWT or
// localStorage here; the UX-level redirect happens in `app/saas/layout.tsx`'s
// `useEffect` after first paint. The backend guard remains the source of truth.
// `/register` was listed here and in the matcher below for a long time. That
// route does not exist -- it answers 404. The sign-up page is `/signup`, and
// it was not listed at all.
//
// The middleware now also serves salons' own domains (see
// lib/custom-domain-host.ts), which is why the matcher covers every page.

const PLATFORM_HOSTS = platformHostsFrom(
  process.env.NEXT_PUBLIC_PLATFORM_HOSTS,
  process.env.NEXT_PUBLIC_APP_URL,
);

const API_URL = (
  process.env.INTERNAL_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:3001/api/v1"
).replace(/\/+$/, "");

/**
 * Host -> salon slug (or null for "no salon"), per server process. Every
 * request on a salon's domain goes through here, so the API is asked at
 * most once per host every few minutes. Unknown hosts are remembered for
 * less time, so a domain verified a minute ago starts working soon; the map
 * is capped so a flood of made-up Host headers cannot grow it without bound.
 */
const HIT_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;
const MAX_ENTRIES = 2_000;
const hostCache = new Map<string, { slug: string | null; expires: number }>();

async function slugForHost(host: string): Promise<string | null> {
  const now = Date.now();
  const cached = hostCache.get(host);
  if (cached && cached.expires > now) return cached.slug;

  let slug: string | null = null;
  let ttl = MISS_TTL_MS;
  try {
    const res = await fetch(`${API_URL}/public-site/domain/${encodeURIComponent(host)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { slug?: unknown };
      if (typeof body.slug === "string" && body.slug) {
        slug = body.slug;
        ttl = HIT_TTL_MS;
      }
    } else if (res.status !== 404) {
      // API trouble is not an answer: do not remember it.
      return cached?.slug ?? null;
    }
  } catch {
    return cached?.slug ?? null;
  }

  if (hostCache.size >= MAX_ENTRIES) hostCache.clear();
  hostCache.set(host, { slug, expires: now + ttl });
  return slug;
}

export async function middleware(request: NextRequest) {
  const host = bareHost(request.headers.get("host"));
  if (!isPlatformHost(host, PLATFORM_HOSTS)) {
    const slug = await slugForHost(host);
    if (slug) {
      const target = rewritePathFor(request.nextUrl.pathname, encodeURIComponent(slug));
      if (target) {
        const url = request.nextUrl.clone();
        url.pathname = target;
        return NextResponse.rewrite(url);
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  // Every page; not Next's own assets nor files (anything with an
  // extension: favicon.ico, robots.txt, sitemap.xml, images in public/),
  // which are the same on every host.
  matcher: ["/((?!_next/|.*\\.).*)"],
};
