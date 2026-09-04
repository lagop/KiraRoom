import {
  Injectable,
  NestMiddleware,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { correlationStorage } from "./correlation.context";

const HEADER = "x-request-id";

/**
 * Per-request correlation id middleware.
 *
 * - Generates a UUID for each incoming request (or honors the
 *   `X-Request-Id` header if the client / upstream proxy sent one).
 * - Stores the id in an AsyncLocalStorage so any logger / service
 *   can pull it without threading it through every call site.
 * - Sets `req.id` so nestjs-pino (which logs the access line after
 *   this middleware) uses the **same** id we publish on the response
 *   header and in `correlationStorage`.
 * - Echoes the id back as `X-Request-Id` so the client can correlate.
 *
 * No third-party dependencies — uses Node 18+'s built-in
 * AsyncLocalStorage. This keeps the dependency tree minimal in the
 * zero-budget launch window.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[HEADER];
    const id =
      (typeof incoming === "string" && incoming.length > 0
        ? incoming
        : undefined) || randomUUID();

    res.setHeader(HEADER, id);

    (req as any).requestId = id;
    (req as any).id = id;

    correlationStorage.run({ requestId: id, startedAt: Date.now() }, () => {
      next();
    });
  }
}