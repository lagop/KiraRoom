import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AssistantTierService } from './assistant-tier.service';

/**
 * P2A-staff-copilot-sprint16 — soft-launch guard.
 *
 * Runs AFTER `JwtAuthGuard` + `RolesGuard` + `FeatureGuard` so the
 * tenant has already been authenticated and authorized at the
 * plan-feature level. This guard only enforces the
 * `COPILOT_SOFT_LAUNCH_TENANT_IDS` env-var whitelist.
 *
 * In GA mode (whitelist empty) the guard is a pass-through.
 * During soft-launch, only listed tenants get through; everyone else
 * receives 403 `COPILOT_NOT_IN_SOFT_LAUNCH` and the panel shows the
 * upgrade prompt with a different message ("we're in closed beta").
 */
@Injectable()
export class AssistantSoftLaunchGuard implements CanActivate {
  constructor(private readonly tiers: AssistantTierService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const tenantId: string | undefined = req?.user?.tenantId;
    if (!tenantId) return true; // let other guards handle missing context

    if (!this.tiers.isSoftLaunchAllowed(tenantId)) {
      throw new ForbiddenException({
        code: 'COPILOT_NOT_IN_SOFT_LAUNCH',
        message: 'Tu salón aún no tiene acceso al copiloto. Estamos en beta cerrada; te avisamos cuando esté disponible.',
      });
    }
    return true;
  }
}
