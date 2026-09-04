import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface JwtPayload {
  sub: string;      // userId
  email: string;
  role: string;
  tenantId: string;
  plan?: string;     // subscription plan
  iat?: number;
  exp?: number;
  // Impersonation claims (only set on tokens minted via /auth/impersonate).
  impersonatedBy?: string;
  impersonationId?: string;
  impersonatedTenantId?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.role === 'client') {
      // Find client by id
      const client = await this.prisma.client.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          tenantId: true,
          status: true,
        },
      });

      if (!client || client.status === 'blocked') {
        throw new UnauthorizedException('Invalid token or client blocked');
      }

      // Return client data with role
      return {
        id: client.id,
        email: client.email,
        firstName: client.firstName,
        lastName: client.lastName,
        role: 'client',
        tenantId: client.tenantId,
      };
    } else {
      // Find user by id with tenant plan info
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          tenantId: true,
          isActive: true,
          tenant: {
            select: {
              plan: true,
              subscriptionStatus: true,
            },
          },
        },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('Invalid token or user inactive');
      }

      // Return user data with plan info
      return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        tenantId: user.tenantId,
        plan: user.tenant?.plan || 'basic',
        subscriptionStatus: user.tenant?.subscriptionStatus || 'trialing',
        // Forward impersonation claims (set only by POST /auth/impersonate
        // via generateTokens' extraClaims argument) so req.user.impersonatedBy
        // is populated on every backend request from an impersonated session.
        impersonatedBy: payload.impersonatedBy,
        impersonationId: payload.impersonationId,
        impersonatedTenantId: payload.impersonatedTenantId,
      };
    }
  }
}
