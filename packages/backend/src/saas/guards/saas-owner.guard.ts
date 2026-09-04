import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SAAS_OWNER_KEY } from '../decorators/saas-owner.decorator';

@Injectable()
export class SaasOwnerGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isSaasOwnerRoute = this.reflector.getAllAndOverride<boolean>(SAAS_OWNER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isSaasOwnerRoute) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    return user?.role === 'saas_owner';
  }
}