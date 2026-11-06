import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { NOT_DURING_SUPPORT, supportModeException } from "../decorators/not-during-support.decorator";
import { AuditLogService } from "../../saas/audit-log.service";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Global, after JwtAuthGuard: a support session (req.user.impersonatedBy,
 * set only from the signed impersonation claim) gets a 403 "No disponible
 * en modo soporte" on every @NotDuringSupport route. The salon's own team
 * is never affected.
 *
 * Every other write a support session makes is recorded in the audit log
 * (method and route, never the body), so the ones that do not write their
 * own row (refunds, campaigns, deletions) still leave a trace naming the
 * platform owner (audit 2026-11-06).
 */
@Injectable()
export class SupportScopeGuard implements CanActivate {
  private readonly logger = new Logger(SupportScopeGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditLog?: AuditLogService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== "http") return true;
    const user = ctx.switchToHttp().getRequest()?.user;
    if (!user?.impersonatedBy) return true;
    const denied = this.reflector.getAllAndOverride<boolean | undefined>(NOT_DURING_SUPPORT, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (denied) throw supportModeException();
    const req = ctx.switchToHttp().getRequest();
    if (this.auditLog && WRITES.has(String(req?.method).toUpperCase())) {
      // Never holds the request up, and never fails it.
      void this.auditLog
        .record("support.request", {
          actorId: user.id,
          actorRole: user.role,
          tenantId: user.tenantId,
          metadata: { method: req.method, route: req.route?.path ?? String(req.url ?? "").split("?")[0].slice(0, 200) },
        })
        .catch((err: Error) => this.logger.warn(`Support request not recorded: ${err.message}`));
    }
    return true;
  }
}
