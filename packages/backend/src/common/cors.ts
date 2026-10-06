import { Logger } from '@nestjs/common';
import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { slugFromSalonSubdomain } from '@kira/shared';

/**
 * CORS allow-list, and the 403 that a rejection should produce.
 *
 * A disallowed origin used to answer **500**. `app.enableCors()` installs
 * the `cors` express middleware, and calling its callback with a plain
 * `Error` makes that middleware do `next(err)`. That happens *before*
 * Nest's router, so the error never reaches a Nest exception filter --
 * throwing `ForbiddenException` there would not help. Express falls
 * through to its default error handler, which answers 500.
 *
 * A server error is the wrong thing to say. The request was understood
 * and refused, and 500 tells an operator reading logs or an uptime check
 * that the API is broken. During the CORS outage the preflight for
 * /auth/login answered 500 and the only visible symptom in the browser
 * was "Failed to fetch", with nothing to indicate a configuration
 * problem rather than a crash.
 *
 * So the rejection is tagged with its own error type and translated by an
 * express error handler registered after the CORS middleware.
 *
 * Note what this is not: CORS is enforced by browsers, never by us. Any
 * non-browser client ignores it entirely. The allow-list keeps a page on
 * another origin from reading responses in a user's browser; it is not
 * access control, and a 403 here is a clearer answer, not a stronger one.
 */
export class CorsOriginNotAllowedError extends Error {
  constructor(readonly origin: string) {
    super(`Origin not allowed by CORS policy: ${origin}`);
    this.name = 'CorsOriginNotAllowedError';
  }
}

export const DEFAULT_DEV_ORIGIN = 'http://localhost:3000';

/**
 * The allow-list, in precedence order: CORS_ALLOWED_ORIGINS, then
 * FRONTEND_URL, then the dev default.
 *
 * Both variables were absent in production for as long as the compose
 * failed to forward them, so this silently resolved to the dev default
 * and rejected the real dashboard. `deploy-env-forwarding.spec.ts` now
 * pins that they reach the container.
 */
export function parseAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.CORS_ALLOWED_ORIGINS || env.FRONTEND_URL || DEFAULT_DEV_ORIGIN)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Origins that serve a salon's page and so call this API from the browser:
 * its free subdomain (https://salon-lucia.kiraroom.net) and its own verified
 * domain (https://reservas.misalon.com). Without them the page loads but
 * the booking form cannot fetch slots or book. Only https, no port.
 */
export async function salonOriginAllowed(
  origin: string,
  subdomainBase: string | undefined,
  isVerifiedDomain: (host: string) => Promise<boolean>,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (slugFromSalonSubdomain(host, subdomainBase)) return true;
  return isVerifiedDomain(host);
}

export function buildCorsOptions(
  allowedOrigins: string[],
  logger: Pick<Logger, 'warn'>,
  /** Origins decided at request time (salons' subdomains and domains). */
  extraAllowed?: (origin: string) => Promise<boolean>,
): CorsOptions {
  const allowsAny = allowedOrigins.includes('*');
  if (allowsAny) {
    // Once, at startup. This used to be logged inside the callback, so a
    // wide-open deploy wrote a warning line per request instead of one.
    logger.warn(
      'CORS_ALLOWED_ORIGINS contains "*" — allowing all origins. ' +
        'Set a specific allow-list before going to production.',
    );
  }

  return {
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) => {
      // No Origin header: same-origin, curl, health probes. Nothing to check.
      if (!origin) return cb(null, true);
      if (allowsAny) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);

      const reject = () => {
        logger.warn(`CORS blocked origin: ${origin}`);
        cb(new CorsOriginNotAllowedError(origin), false);
      };
      if (!extraAllowed) return reject();
      extraAllowed(origin).then(
        (ok) => (ok ? cb(null, true) : reject()),
        () => reject(),
      );
    },
    credentials: true,
  };
}

/**
 * Express error handler turning a CORS rejection into 403. Must be
 * registered after `enableCors`, and passes anything else along.
 */
export const corsRejectionHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!(err instanceof CorsOriginNotAllowedError)) return next(err);

  // Same shape as Nest's ForbiddenException, so clients see one format.
  res.status(403).json({
    statusCode: 403,
    message: 'Origin not allowed by CORS policy',
    error: 'Forbidden',
  });
};
