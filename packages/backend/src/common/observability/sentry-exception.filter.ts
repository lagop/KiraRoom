import { ArgumentsHost, Catch, HttpException, HttpStatus } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import * as Sentry from "@sentry/node";

/**
 * Reports server errors to GlitchTip (Sentry protocol), then lets Nest
 * answer exactly as before (audit 8 D6).
 *
 * Nest catches every controller exception with its own handler and answers
 * 500, so the Express error handler Sentry registered never saw one and
 * GlitchTip only heard of process crashes. Registered as APP_FILTER in
 * AppModule; WebSocket gateways do not use global filters.
 *
 * Only 5xx and unexpected (non-HttpException) errors are reported: a 4xx is
 * the client's mistake, not ours. The event carries the method, the route
 * pattern (`/clients/:id`, never the concrete URL or its query) and the
 * status; no body, no user. With no DSN configured Sentry is not initialised
 * and captureException does nothing.
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === "http") {
      const status = statusOf(exception);
      if (status >= 500) {
        const req = host.switchToHttp().getRequest<{ method?: string; route?: { path?: string } }>();
        Sentry.captureException(exception, {
          tags: {
            "http.method": req?.method ?? "unknown",
            "http.route": req?.route?.path ?? "unmatched",
            "http.status_code": String(status),
          },
        });
      }
    }
    super.catch(exception, host);
  }
}

export function statusOf(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
