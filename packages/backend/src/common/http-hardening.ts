import type { INestApplication } from "@nestjs/common";
import helmet from "helmet";

/**
 * Which hops may set X-Forwarded-For.
 *
 * In production the API sits behind Traefik, on the Docker network. Without
 * this, Express saw every request as coming from Traefik's address, so a
 * per-IP limit would have been one bucket shared by every visitor. Trusting
 * only private and loopback addresses means a client that reaches the API
 * directly cannot pick its own address by sending the header.
 */
export const TRUSTED_PROXIES = "loopback, linklocal, uniquelocal";

/**
 * Response headers and proxy trust for the API.
 *
 * helmet was a dependency but was never installed in the app, so the API
 * answered without HSTS, nosniff or frame protection and announced
 * "X-Powered-By: Express".
 */
export function applyHttpHardening(app: INestApplication): void {
  const http = app.getHttpAdapter().getInstance();
  http.set("trust proxy", TRUSTED_PROXIES);
  http.disable("x-powered-by");
  app.use(
    helmet({
      // JSON API: a CSP protects documents, and the only HTML served here
      // is the Swagger UI in development, which needs inline scripts.
      contentSecurityPolicy: false,
      // The app (app.kiraroom.net) and salon sites load logos and PDFs from
      // api.kiraroom.net; same-origin would block them.
      crossOriginResourcePolicy: { policy: "cross-origin" },
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
    }),
  );
}

/**
 * The interactive API docs list every route and its parameters. Useful in
 * development; in production they are a map for whoever probes the API.
 */
export function swaggerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || env.SWAGGER_ENABLED === "1";
}
