import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { verify } from "jsonwebtoken";

/**
 * The tenant a public list endpoint (GET /services, GET /professionals)
 * should answer for.
 *
 * Those routes are `@Public()` because a salon's public site lists its own
 * catalogue and team. But `@Public()` skips the JWT guard entirely, so no
 * tenant is ever bound and the tenant scope does not apply -- and the
 * services only filtered when a `tenantId` query was given. Nine dashboard
 * and client-portal screens call them without one, and got every salon's
 * rows back; anyone could do the same anonymously, which for professionals
 * meant every salon's staff with their email and phone.
 *
 * Resolution, in order:
 * 1. An explicit `?tenantId=` -- the public site asking for its own salon.
 *    That data is public by design, so any caller may ask for it.
 * 2. The tenant of a valid bearer token -- the dashboard and client portal.
 *    Read here rather than by running the guard, so a public route does not
 *    start binding the caller's tenant: that would make salon B's public
 *    page answer 403 to someone logged into salon A.
 * 3. Otherwise nothing is listed: 401 for a bad token (so the client
 *    refreshes it), 400 when there was no token at all.
 */
export function tenantForPublicList(
  req: { headers?: Record<string, unknown> },
  queryTenantId: string | undefined,
  secret: string | undefined = process.env.JWT_SECRET,
): string {
  if (queryTenantId) return queryTenantId;

  const header = req.headers?.authorization;
  const match = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header) : null;
  if (!match) {
    throw new BadRequestException("tenantId is required");
  }

  let payload: unknown;
  try {
    if (!secret) throw new Error("JWT_SECRET is not configured");
    payload = verify(match[1], secret);
  } catch {
    throw new UnauthorizedException("Invalid or expired token");
  }

  const tenantId = (payload as { tenantId?: unknown })?.tenantId;
  if (typeof tenantId !== "string" || !tenantId) {
    // A saas_owner token carries no tenant; it must say which one it means.
    throw new BadRequestException("tenantId is required");
  }
  return tenantId;
}
