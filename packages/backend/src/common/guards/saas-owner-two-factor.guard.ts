import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import {
  ALLOW_WITHOUT_TWO_FACTOR,
  saasOwnerTwoFactorException,
  saasOwnerTwoFactorRequired,
} from "../../auth/two-factor/saas-owner-two-factor";

/**
 * Global, after JwtAuthGuard (audit 8 D15). Only with
 * SAAS_OWNER_2FA_REQUIRED=true, and only for a platform owner's own session
 * (JwtStrategy sets twoFactorRequired on it): every route but the
 * @AllowWithoutTwoFactor ones is refused until 2FA is on. Public routes
 * (sign-in, refresh) carry no user and pass.
 */
@Injectable()
export class SaasOwnerTwoFactorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== "http") return true;
    const user = ctx.switchToHttp().getRequest()?.user;
    if (user?.role !== "saas_owner" || user.twoFactorEnabled !== false) return true;
    if (!saasOwnerTwoFactorRequired((key) => this.config.get<string>(key))) return true;
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WITHOUT_TWO_FACTOR, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (allowed) return true;
    throw saasOwnerTwoFactorException();
  }
}
