import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { tenantStorage } from "./tenant.context";

/**
 * Opens the per-request tenant context.
 *
 * Runs before the guards, so `req.user` is not available yet: the
 * store starts in bypass mode and `JwtStrategy.validate()` binds the
 * tenant once the user has been loaded. Everything downstream of
 * `next()` -- guards, interceptors, controllers, services -- shares
 * the same mutable store through AsyncLocalStorage.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    tenantStorage.run({ tenantId: null, bypass: true }, () => next());
  }
}
