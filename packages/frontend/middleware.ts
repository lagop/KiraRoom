import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// All authentication for `/saas/*` is enforced server-side by the NestJS
// `SaasOwnerGuard` on the corresponding API endpoints. This middleware is
// intentionally permissive for SaaS routes because we cannot read JWT or
// localStorage here; the UX-level redirect happens in `app/saas/layout.tsx`'s
// `useEffect` after first paint. The backend guard remains the source of truth.
const publicPaths = ["/saas/login", "/login", "/register"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  for (const path of publicPaths) {
    if (pathname.startsWith(path)) {
      return NextResponse.next();
    }
  }

  // Let the layout handle auth check for SaaS routes (it can access localStorage)
  return NextResponse.next();
}

export const config = {
  matcher: ["/saas/:path*", "/login", "/register"],
};