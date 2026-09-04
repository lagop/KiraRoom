import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Paths that should bypass JWT auth entirely (no `@Public()` decorator
 * dependency, which is currently broken in the codebase).
 * Keep this list minimal — only public resolution endpoints.
 */
const PUBLIC_PATH_PREFIXES = [
  '/api/v1/public-site/',
];

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Path-based bypass for endpoints declared public without @Public()
    const req = context.switchToHttp().getRequest();
    const url: string = req?.url || '';
    if (PUBLIC_PATH_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('Authentication required');
    }
    return user;
  }
}
