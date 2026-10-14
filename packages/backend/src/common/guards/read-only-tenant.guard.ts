import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ALLOW_WHEN_READ_ONLY } from "../decorators/allow-when-read-only.decorator";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a salon with this subscription status may only read. */
export function isReadOnlyStatus(status: string | null | undefined): boolean {
  return status === "cancelled" || status === "suspended";
}

/** The refusal a read-only salon gets; same payload as FeatureGuard's. */
export function readOnlyException(status: string): ForbiddenException {
  const suspended = status === "suspended";
  return new ForbiddenException({
    code: suspended ? "SUBSCRIPTION_SUSPENDED" : "SUBSCRIPTION_CANCELLED",
    message: suspended
      ? "Tu suscripción está suspendida por falta de pago. Esta acción está disponible solo para planes activos."
      : "Tu suscripción está cancelada. Esta acción está disponible solo para planes activos.",
    reactivateUrl: "/dashboard/billing",
    upgradeUrl: "/dashboard/billing",
    exportAvailable: true,
  });
}

/**
 * Read-only mode for the salon's team once the trial ends without a plan,
 * or the subscription is cancelled or suspended: they can still sign in,
 * read and export, and pay, but not write. FeatureGuard did this only on
 * @Feature routes, so appointments, clients and services stayed writable.
 *
 * Global, after RolesGuard (it needs req.user). Clients of the salon carry
 * no subscription status and are not affected here; their bookings are
 * refused in AppointmentsService. The platform owner is never read-only.
 */
@Injectable()
export class ReadOnlyTenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== "http") return true;
    const req = ctx.switchToHttp().getRequest();
    const user = req?.user;
    if (!user?.tenantId || user.role === "saas_owner" || user.role === "client") return true;
    if (!isReadOnlyStatus(user.subscriptionStatus)) return true;
    if (READ_METHODS.has(String(req.method || "GET").toUpperCase())) return true;
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WHEN_READ_ONLY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (allowed) return true;
    throw readOnlyException(user.subscriptionStatus);
  }
}
