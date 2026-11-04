/**
 * The address a request came from, by the same rule as the rate limiter
 * (guards/throttler-behind-proxy.guard.ts): `req.ip`, which Express derives
 * from X-Forwarded-For only through the hops in TRUSTED_PROXIES
 * (http-hardening.ts). Reading the header's first value instead took
 * whatever the client wrote in it, so an IP kept as evidence of a consent
 * proved nothing.
 */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } } | null | undefined): string {
  return req?.ip || req?.socket?.remoteAddress || "";
}
