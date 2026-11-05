import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { bindActor, bindTenant } from '../../common/tenancy/tenant.context';
import { isAccessTokenPayload, supportClaims } from '../session-token';
import { SALON_BLOCKED_MESSAGE, SALON_DELETED_MESSAGE } from '../salon-deleted';
import { supportAccessAllowed } from '../support-access/support-access';
import { saasOwnerTwoFactorRequired } from '../two-factor/saas-owner-two-factor';

export interface JwtPayload {
  sub: string;      // userId
  email: string;
  role: string;
  tenantId: string;
  plan?: string;     // subscription plan
  tv?: number;       // session version; absent on tokens minted before it existed (= 0)
  iat?: number;
  exp?: number;
  // Impersonation claims (only set on tokens minted via /auth/impersonate).
  impersonatedBy?: string;
  impersonationId?: string;
  impersonatedTenantId?: string;
  impersonationEndsAt?: number;
  impersonatorTv?: number;
  /** "access" on a session's access token (C11); see session-token.ts. */
  typ?: string;
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
    // Only a session's access token is a session (audit 8, C11): not the
    // 2FA step's token, the support entry token, or anything else signed
    // with this key. One minted before typ existed is refused too; the
    // panel renews it with its refresh cookie.
    if (!isAccessTokenPayload(payload)) {
      throw new UnauthorizedException('Invalid token');
    }
    if (payload.role === 'client') {
      // Clients have no accounts any more (no sign-in on the salon's site);
      // a token minted before that is refused, so no client-only route can
      // be reached.
      throw new UnauthorizedException('Client accounts are no longer available');
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
          tokenVersion: true,
          twoFactorEnabled: true,
          tenant: {
            select: {
              plan: true,
              subscriptionStatus: true,
              deletedAt: true,
              blockedAt: true,
              allowSupportAccess: true,
            },
          },
        },
      });

      // Its salon was deleted from the platform console (the deletion also
      // deactivates the team and ends their sessions; this holds regardless).
      if (user?.tenant?.deletedAt && user.role !== 'saas_owner') {
        throw new UnauthorizedException(SALON_DELETED_MESSAGE);
      }
      // Blocked from the console (audit 8 D4): its sessions end now. A
      // support session of the platform owner can still look into it.
      if (user?.tenant?.blockedAt && user.role !== 'saas_owner' && !payload.impersonatedBy) {
        throw new UnauthorizedException(SALON_BLOCKED_MESSAGE);
      }
      if (!user || !user.isActive) {
        throw new UnauthorizedException('Invalid token or user inactive');
      }
      // Logged out, or the password changed, since this token was issued.
      if ((payload.tv ?? 0) !== user.tokenVersion) {
        throw new UnauthorizedException('Session ended');
      }

      // Bind the per-request tenant context (saas_owner is bound in
      // bypass mode: the platform console reads across tenants and is
      // authorised by SaasOwnerGuard, not by this filter).
      bindTenant(user.tenantId, user.role);

      // A support session (the platform owner inside a salon) ends at its cap
      // and as soon as the platform owner's own sessions end: logout
      // everywhere, a new password, the account deactivated (C2, C13).
      if (payload.impersonatedBy) {
        await this.assertSupportSessionLive(payload);
        // D2: the owner turned support access off: an open session ends.
        if (!supportAccessAllowed(user.tenant)) {
          throw new UnauthorizedException('La sesión de soporte ha terminado.');
        }
      }
      bindActor({
        userId: user.id,
        role: user.role,
        ...(payload.impersonatedBy && {
          impersonatedBy: payload.impersonatedBy,
          impersonationId: payload.impersonationId,
        }),
      });

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
        // D15: the platform owner's 2FA, for SaasOwnerTwoFactorGuard and the
        // console (it sends her to set it up when it is required).
        ...(user.role === 'saas_owner' && {
          twoFactorEnabled: user.twoFactorEnabled === true,
          twoFactorRequired:
            user.twoFactorEnabled !== true && saasOwnerTwoFactorRequired((key) => this.configService.get<string>(key)),
        }),
      };
    }
  }

  private async assertSupportSessionLive(payload: JwtPayload): Promise<void> {
    const claims = supportClaims(payload as Record<string, any>);
    // A support token from before the cap existed has no end: it ends now.
    if (!claims || claims.impersonationEndsAt * 1000 <= Date.now()) {
      throw new UnauthorizedException('La sesión de soporte ha terminado.');
    }
    const impersonator = await this.prisma.user.findUnique({
      where: { id: claims.impersonatedBy },
      select: { role: true, isActive: true, tokenVersion: true },
    });
    if (
      !impersonator ||
      !impersonator.isActive ||
      impersonator.role !== 'saas_owner' ||
      impersonator.tokenVersion !== claims.impersonatorTv
    ) {
      throw new UnauthorizedException('La sesión de soporte ha terminado.');
    }
  }
}
