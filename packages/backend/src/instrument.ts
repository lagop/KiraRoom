/**
 * Sentry / GlitchTip initialisation. Imported first by main.ts: the Sentry
 * SDK has to load before Nest, Express and the HTTP clients so its
 * integrations (http, express, nest) can hook in. It used to run inside
 * bootstrap(), after all of them had been imported.
 *
 * Activated by SENTRY_DSN (or GLITCHTIP_DSN) in the process environment;
 * without it nothing is initialised and nothing leaves the box. Note it
 * reads the real environment (compose), not packages/backend/.env, which
 * ConfigModule loads later.
 *
 * What gets reported:
 *   - HTTP 5xx and unexpected exceptions, by SentryExceptionFilter
 *     (common/observability/sentry-exception.filter.ts);
 *   - scheduled jobs that throw, by @MonitoredJob (common/ops-alerts).
 * No request bodies, cookies, query strings, headers other than a short
 * allow-list, or user emails / IPs are sent (beforeSend below).
 */
import * as Sentry from "@sentry/node";

export const SENTRY_DSN = process.env.SENTRY_DSN || process.env.GLITCHTIP_DSN;
const SENTRY_TRACES_SAMPLE_RATE = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1");

/** Request headers worth keeping on an event: none carries a credential or PII. */
const SAFE_HEADERS = new Set(["user-agent", "content-type", "accept", "x-request-id"]);

/** Exported for the spec: strips PII from an event before it leaves the box. */
export function scrubEvent<T extends Sentry.Event>(event: T): T {
  if (event.request) {
    if (event.request.data) delete event.request.data;
    if (event.request.cookies) delete event.request.cookies;
    // Spanish endpoints commonly accept PII via query parameters
    // (e.g. `GET /clients?taxId=B12345678`). Strip the querystring
    // before the URL leaves the box.
    if (event.request.url) {
      try {
        const u = new URL(event.request.url);
        u.search = "";
        event.request.url = u.toString();
      } catch {
        /* not a parseable URL — leave alone */
      }
    }
    if (event.request.query_string) delete event.request.query_string;
    // Authorization, cookies, the impersonation token...: keep only an
    // allow-list.
    if (event.request.headers) {
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(event.request.headers)) {
        if (SAFE_HEADERS.has(k.toLowerCase())) kept[k] = v;
      }
      event.request.headers = kept;
    }
  }
  if (event.user) {
    // Never send email or IP.
    if (event.user.email) delete event.user.email;
    if (event.user.ip_address) delete event.user.ip_address;
    if (event.user.username) delete event.user.username;
  }
  return event;
}

function initSentry(): void {
  if (!SENTRY_DSN) return;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    // Nest's own integration (spans for controllers, guards, cron); the
    // errors are captured by the global filter, not by this.
    integrations: [Sentry.nestIntegration()],
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    // Same scrubbing applies to breadcrumbs (e.g. fetch() calls).
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data?.url) {
        try {
          const u = new URL(breadcrumb.data.url);
          u.search = "";
          breadcrumb.data.url = u.toString();
        } catch {
          /* not a parseable URL — leave alone */
        }
      }
      return breadcrumb;
    },
  });
}

initSentry();
