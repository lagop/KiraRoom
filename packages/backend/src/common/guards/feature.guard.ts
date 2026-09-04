import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagService } from '../feature-flags/feature-flag.service';
import { FeatureKey } from '../../payments/services/subscriptions.service';
import { FEATURE_KEY_METADATA } from '../decorators/feature.decorator';

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly flags: FeatureFlagService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<FeatureKey | undefined>(
      FEATURE_KEY_METADATA,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!key) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest();
    const tenantId = req?.user?.tenantId;
    if (!tenantId) {
      // Public / webhook routes (no authenticated user) – let other guards
      // decide whether to allow the request. We only enforce feature gating
      // when a tenant context is present.
      return true;
    }

    // Read-only mode: cancelled + suspended tenants can still GET
    // (read & export), but writes (POST/PUT/PATCH/DELETE) are denied
    // with a 423-style payload. Free tenants that lack a feature are
    // still denied regardless of method (they should upgrade).
    const method = (req.method || "GET").toUpperCase();
    const isRead = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const subscriptionStatus = req?.user?.subscriptionStatus as string | undefined;
    const isCancelledOrSuspended =
      subscriptionStatus === "cancelled" ||
      subscriptionStatus === "suspended";

    const enabled = await this.flags.isEnabled(tenantId, key);
    if (!enabled) {
      if (isCancelledOrSuspended && isRead) {
        // Read-only mode for cancelled/suspended tenants.
        return true;
      }
      throw new ForbiddenException({
        code: isCancelledOrSuspended
          ? subscriptionStatus === "suspended"
            ? "SUBSCRIPTION_SUSPENDED"
            : "SUBSCRIPTION_CANCELLED"
          : "FEATURE_NOT_IN_PLAN",
        message: isCancelledOrSuspended
          ? subscriptionStatus === "suspended"
            ? `Tu suscripción está suspendida por falta de pago. Esta acción está disponible solo para planes activos.`
            : `Tu suscripción está cancelada. Esta acción está disponible solo para planes activos.`
          : `Feature '${key}' no disponible en tu plan actual.`,
        reactivateUrl: "/dashboard/billing",
        upgradeUrl: "/dashboard/billing",
        exportAvailable: isCancelledOrSuspended,
      });
    }
    return true;
  }
}
