import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { NOT_DURING_SUPPORT, supportModeException } from "../decorators/not-during-support.decorator";

/**
 * Global, after JwtAuthGuard: a support session (req.user.impersonatedBy,
 * set only from the signed impersonation claim) gets a 403 "No disponible
 * en modo soporte" on every @NotDuringSupport route. The salon's own team
 * is never affected.
 */
@Injectable()
export class SupportScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== "http") return true;
    const user = ctx.switchToHttp().getRequest()?.user;
    if (!user?.impersonatedBy) return true;
    const denied = this.reflector.getAllAndOverride<boolean | undefined>(NOT_DURING_SUPPORT, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (denied) throw supportModeException();
    return true;
  }
}
