import { randomUUID } from "crypto";
import type { Request } from "express";
import { Params } from "nestjs-pino";
import { IncomingMessage } from "http";

const REQUEST_ID_HEADER = "x-request-id";

function reqIdFromHeader(req: IncomingMessage): string {
  const fromHeader = req.headers[REQUEST_ID_HEADER];
  if (typeof fromHeader === "string" && fromHeader.length > 0) {
    return fromHeader;
  }
  return randomUUID();
}

/**
 * nestjs-pino logger configuration.
 *
 * - Emits JSON lines in production (one log per request, one log per
 *   `Logger.log` call). Easy to ingest later by Loki / Datadog without
 *   code changes.
 * - Pretty-prints in development via `pino-pretty`.
 * - Reuses the `X-Request-Id` header (or generates one) so the
 *   correlation id printed by `CorrelationIdMiddleware` and the id
 *   printed by pino on the access log are always the same value.
 * - `serializers.req` / `serializers.res` strip body and authorization
 *   header so PII / secrets never reach the log pipeline.
 * - `redact` belt-and-braces: any field whose name matches a secret
 *   pattern is replaced with `[Redacted]` even if a custom serializer
 *   forgets to strip it.
 */
export const loggerConfig: Params = {
  pinoHttp: {
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
    messageKey: "message",
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    genReqId: reqIdFromHeader,
    customProps: (req: Request) => ({
      requestId: (req as Request & { id?: string }).id ?? null,
      tenantId: (req as Request & { tenantId?: string }).tenantId ?? null,
    }),
    serializers: {
      req(req: any) {
        // Strip the querystring before logging. PII can ride in
        // query parameters (tax IDs, emails, etc.) and the
        // `redact` paths below cover named fields, not arbitrary
        // `?key=value` pairs.
        const fullUrl: string = req.url || "";
        const urlNoQuery = fullUrl.split("?")[0];
        return {
          id: req.id,
          method: req.method,
          url: urlNoQuery,
          remoteAddress: req.remoteAddress,
        };
      },
      res(res: any) {
        return {
          statusCode: res.statusCode,
        };
      },
      err(err: any) {
        return {
          type: err.type ?? err.name,
          message: err.message,
          stack: err.stack,
        };
      },
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers[\"x-api-key\"]",
        "req.body.password",
        "req.body.token",
        "req.body.refreshToken",
        "req.body.accessToken",
        "req.body.card",
        "req.body.cvv",
        "req.query.password",
        "req.query.token",
        "req.query.taxId",
        "req.query.nif",
        "req.query.email",
        "*.password",
        "*.token",
        "*.secret",
        "*.accessToken",
        "*.refreshToken",
        "*.encryptedAccessToken",
        "*.encryptedPem",
        "*.encryptedRefreshToken",
      ],
      remove: false,
      censor: "[Redacted]",
    },
    autoLogging: {
      ignore: (req: IncomingMessage) => {
        const url = req.url || "";
        return (
          url.startsWith("/api/v1/healthz") ||
          url.startsWith("/api/docs") ||
          url === "/favicon.ico"
        );
      },
    },
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              singleLine: true,
              translateTime: "SYS:HH:MM:ss.l",
              ignore: "pid,hostname",
              colorize: true,
            },
          },
  },
};