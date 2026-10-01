import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SIGNED_IN_KEY } from '../decorators/signed-in.decorator';
import { SAAS_OWNER_KEY } from '../../saas/decorators/saas-owner.decorator';

/**
 * Who may call a route. Global (APP_GUARD, after JwtAuthGuard) and deny by
 * default.
 *
 * It used to let through any route without @Roles, and only ran on the
 * controllers that remembered @UseGuards(RolesGuard). About half the API
 * declared no roles, so any session -- a staff member, or a client who
 * booked online -- could export the client base, send campaigns, change
 * the receptionist, edit products or grant itself message credits.
 *
 * A route now has to declare who it is for:
 * - @Public()     no session needed;
 * - @Roles(...)   one of these roles (SALON_TEAM, SALON_MANAGERS);
 * - @SaasOwner()  the platform owner;
 * - @SignedIn()   any session, clients included.
 * Anything else is refused, so a new route is closed until someone decides.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Gateways and queues authenticate their own way.
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, targets);
    if (requiredRoles) {
      return !!user && requiredRoles.includes(user.role);
    }
    if (this.reflector.getAllAndOverride<boolean>(SAAS_OWNER_KEY, targets)) {
      return user?.role === UserRole.saas_owner;
    }
    if (this.reflector.getAllAndOverride<boolean>(SIGNED_IN_KEY, targets)) {
      return !!user;
    }

    this.logger.warn(`Refused ${request.method} ${request.url}: the route declares no roles`);
    throw new ForbiddenException('This route is not open to your account');
  }
}
