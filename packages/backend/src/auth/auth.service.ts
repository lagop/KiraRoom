import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../common/prisma/prisma.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { UserRole } from "@prisma/client";
import {
  assertTenantSlugAvailable,
  createTenantWithOwner,
  getActiveTenant,
  slugify,
} from "../saas/saas.helpers";
import { AuditLogService } from "../saas/audit-log.service";
import { normalizePlan } from "@kira/shared";

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  tenantId: string;
  // Impersonation claims. Populated only when AuthService.impersonate
  // minted this session; absent for normal logins and refreshes.
  impersonatedBy?: string;
  impersonationId?: string;
  impersonatedTenantId?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditLog: AuditLogService,
  ) {}

  async register(
    registerDto: RegisterDto,
  ): Promise<{ user: AuthUser; tokens: TokenResponse }> {
    // Check if email already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: registerDto.email },
    });

    if (existingUser) {
      throw new ConflictException("Email already registered");
    }

    // Slug uniqueness + tenant+owner creation both go through the SaaS
    // helpers so the three creation paths (signup form / SaaS-admin
    // createTenant / invite acceptance) stay in lockstep. Single
    // source of truth for trial length + bcrypt cost lives in
    // saas.constants.ts.
    const slug = slugify(registerDto.salonName);
    await assertTenantSlugAvailable(
      this.prisma,
      slug,
      "Salon name already exists, please choose another",
    );

    // Parse ownerName into firstName and lastName (RegisterDto uses a
    // single ownerName field; CreateTenantDto uses ownerFirstName +
    // ownerLastName. auth.service.register handles the marketing-form path.)
    const nameParts = registerDto.ownerName.trim().split(/\s+/);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    const { tenant: createdTenant, user } = await createTenantWithOwner(this.prisma, {
      name: registerDto.salonName,
      slug,
      plan: "esencial",
      ownerEmail: registerDto.email,
      ownerPassword: registerDto.password,
      ownerFirstName: firstName,
      ownerLastName: lastName,
    });

    const tokens = await this.generateTokens(
      user.id,
      user.email,
      user.role,
      createdTenant.id,
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName,
        lastName,
        role: user.role,
        tenantId: createdTenant.id,
      },
      tokens,
    };
  }

  async login(
    loginDto: LoginDto,
  ): Promise<{ user: AuthUser; tokens: TokenResponse }> {
    // First, try to find user by email
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
      include: { professional: true },
    });

    if (user) {
      // Check if user is active
      if (!user.isActive) {
        throw new UnauthorizedException("Account is deactivated");
      }

      // Verify password
      const isPasswordValid = await bcrypt.compare(
        loginDto.password,
        user.passwordHash,
      );

      if (!isPasswordValid) {
        // Increment login attempts
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            loginAttempts: { increment: 1 },
            lockedUntil:
              user.loginAttempts >= 4
                ? new Date(Date.now() + 30 * 60 * 1000)
                : null, // Lock for 30 min after 5 attempts
          },
        });
        throw new UnauthorizedException("Invalid credentials");
      }

      // Reset login attempts on successful login
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          loginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      });

      // Generate tokens
      const tokens = await this.generateTokens(
        user.id,
        user.email,
        user.role,
        user.tenantId,
        user.professional?.id,
      );

      return {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          tenantId: user.tenantId,
        },
        tokens,
      };
    }

    // If not found as user, try to find as client
    const client = await this.prisma.client.findFirst({
      where: { email: loginDto.email },
    });

    if (client && client.passwordHash) {
      // Verify password
      const isPasswordValid = await bcrypt.compare(
        loginDto.password,
        client.passwordHash,
      );

      if (!isPasswordValid) {
        throw new UnauthorizedException("Invalid credentials");
      }

      // Generate tokens for client (with role 'client')
      const tokens = await this.generateTokens(
        client.id,
        client.email!,
        "client",
        client.tenantId,
      );

      return {
        user: {
          id: client.id,
          email: client.email!,
          firstName: client.firstName,
          lastName: client.lastName,
          role: "client",
          tenantId: client.tenantId,
        },
        tokens,
      };
    }

    // If not found in either table
    throw new UnauthorizedException("Invalid credentials");
  }

  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });

      if (payload.role === "client") {
        // Find client by id
        const client = await this.prisma.client.findUnique({
          where: { id: payload.sub },
        });

        if (!client) {
          throw new UnauthorizedException("Invalid refresh token");
        }

        // Generate new tokens for client
        return this.generateTokens(
          client.id,
          client.email!,
          "client",
          client.tenantId,
        );
      } else {
        // Find user by id
        const user = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          include: { professional: true },
        });

        if (!user || !user.isActive) {
          throw new UnauthorizedException("Invalid refresh token");
        }

        // Carry impersonation claims forward so a silent access-token
        // refresh (lib/api.ts:refreshAccessToken, ~15 min cadence) does
        // not strip the SaaS owner's "you are being impersonated" banner
        // or break any future server-side audit attribution that keys off
        // impersonatedBy / impersonationId. The claims were stamped into
        // the refresh token at mint time by /auth/impersonate, and the
        // refresh token is signed by generateTokens with the same
        // payload object.
        const impersonationClaims = {
          impersonatedBy: payload.impersonatedBy,
          impersonationId: payload.impersonationId,
          impersonatedTenantId: payload.impersonatedTenantId,
        };

        return this.generateTokens(
          user.id,
          user.email,
          user.role,
          user.tenantId,
          user.professional?.id,
          {
            ...(impersonationClaims.impersonatedBy && {
              impersonatedBy: impersonationClaims.impersonatedBy,
            }),
            ...(impersonationClaims.impersonationId && {
              impersonationId: impersonationClaims.impersonationId,
            }),
            ...(impersonationClaims.impersonatedTenantId && {
              impersonatedTenantId: impersonationClaims.impersonatedTenantId,
            }),
          },
        );
      }
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  async logout(userId: string): Promise<void> {
    // In a production system, you would blacklist the tokens here
    // For now, we'll just clear any session data if needed
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        // Add token blacklist logic here if needed
      },
    });
  }

  /**
   * Exchange a SaaS-owner-issued impersonation token for a real session
   * as the tenant owner. Writes an AuditLog row so the impersonation is
   * forever attributable.
   *
   * One-shot semantics: the token's `jti` is atomically inserted into
   * `used_impersonation_tokens`. Any subsequent consume with the same
   * `jti` is rejected with 401.
   *
   * Ordering: validate first, consume last. A failed validation (tenant
   * soft-deleted, owner deactivated) MUST NOT burn the jti — otherwise
   * a flaky mid-call network error would render the token unplayable
   * with no path to retry.
   */
  async impersonate(
    token: string,
    reason: string,
    expectedAudience: string,
  ): Promise<{ user: AuthUser; tokens: TokenResponse }> {
    if (!token) {
      throw new UnauthorizedException("Missing impersonation token");
    }

    let payload: any;
    try {
      payload = this.jwtService.verify(token, { ignoreExpiration: false });
    } catch {
      throw new UnauthorizedException("Invalid or expired impersonation token");
    }

    if (
      payload?.aud !== expectedAudience ||
      !payload?.impersonate?.tenantId ||
      !payload?.impersonate?.ownerId ||
      !payload?.jti
    ) {
      throw new UnauthorizedException("Invalid impersonation token payload");
    }

    const { tenantId, ownerId } = payload.impersonate;
    const jti: string = payload.jti;

    // (1) Validate FIRST. If the target went away since the token was
    // minted, we want to fail-fast without burning the one-shot jti so
    // the SaaS owner can re-launch and try again.
    await getActiveTenant(this.prisma, tenantId);

    const owner = await this.prisma.user.findFirst({
      where: { id: ownerId, tenantId, role: "owner" },
      include: { professional: true },
    });
    if (!owner || !owner.isActive) {
      throw new UnauthorizedException(
        "Target tenant owner is not available for impersonation",
      );
    }

    // (2) Atomic consume + audit. The PK on used_impersonation_tokens.jti
    // means a duplicate insert raises P2002 → 401 (replay protection).
    // Wrapping in $transaction ensures either both rows commit or neither
    // does — an audit_log row without a consumed token, or vice versa,
    // would be a forensic inconsistency. AuditLogService.record() takes
    // the same transaction client so the shape stays canonical with the
    // rest of the platform.
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.usedImpersonationToken.create({
          data: {
            jti,
            tenantId,
            consumedBy: payload.sub as string,
          },
        });
        await this.auditLog.record(
          "saas.impersonate",
          {
            actorId: payload.sub as string,
            actorRole: UserRole.saas_owner,
            tenantId,
            metadata: {
              reason,
              targetOwnerId: owner.id,
              targetOwnerEmail: owner.email,
              impersonationId: jti,
            },
          },
          tx,
        );
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new UnauthorizedException(
          "Impersonation token already consumed — a one-shot token cannot be replayed",
        );
      }
      throw e;
    }

    // (3) Mint real owner session with impersonation claims baked in so the
    // dashboard can render the persistent "you are being impersonated"
    // banner across refreshes and in-app navigations, and so any
    // future server-side logging can key off `impersonatedBy`.
    const tokens = await this.generateTokens(
      owner.id,
      owner.email,
      owner.role,
      owner.tenantId,
      owner.professional?.id,
      {
        impersonatedBy: payload.sub as string,
        impersonationId: jti,
        impersonatedTenantId: tenantId,
      },
    );

    return {
      user: {
        id: owner.id,
        email: owner.email,
        firstName: owner.firstName,
        lastName: owner.lastName,
        role: owner.role,
        tenantId: owner.tenantId,
      },
      tokens,
    };
  }

  async getTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        currency: true,
        country: true,
        language: true,
        // Plan / subscription status (consumed by /dashboard/settings/channels
        // to branch the upgrade CTA: Esencial → buy multichannel add-on,
        // other plans → upgrade plan).
        plan: true,
        subscriptionStatus: true,
        // Identity (consumed by /dashboard/settings/salon and the
        // onboarding wizard's "workspace_business" step).
        description: true,
        street: true,
        city: true,
        postalCode: true,
        state: true,
        phone: true,
        logo: true,
        // Tax identifiers (consumed by /dashboard/settings/fiscal).
        taxId: true,
        taxIdType: true,
        legalName: true,
      },
    });

    if (!tenant) {
      throw new UnauthorizedException("Tenant not found");
    }

    return tenant;
  }

  async updateTenant(tenantId: string, updateData: any) {
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: updateData,
    });
  }

  private async generateTokens(
    userId: string,
    email: string,
    role: string,
    tenantId: string,
    professionalId?: string,
    extraClaims?: {
      impersonatedBy?: string;
      impersonationId?: string;
      impersonatedTenantId?: string;
    },
  ): Promise<TokenResponse> {
    const payload: Record<string, unknown> = {
      sub: userId,
      email,
      role,
      tenantId,
      ...(professionalId && { professionalId }),
      ...(extraClaims?.impersonatedBy && {
        impersonatedBy: extraClaims.impersonatedBy,
      }),
      ...(extraClaims?.impersonationId && {
        impersonationId: extraClaims.impersonationId,
      }),
      ...(extraClaims?.impersonatedTenantId && {
        impersonatedTenantId: extraClaims.impersonatedTenantId,
      }),
    };

    // Parse expiresIn values. Accepts both seconds ("3600") and
    // stringified durations as the Nest JWT module does: "15m", "1h",
    // "7d", "30s". Defaults: 8h access, 7d refresh (long enough that a
    // legitimate actively-used user never sees a forced re-login).
    const accessTokenExpiresIn = parseJwtDuration(
      process.env.JWT_EXPIRES_IN,
      8 * 60 * 60,
    );
    const refreshTokenExpiresIn = parseJwtDuration(
      process.env.JWT_REFRESH_EXPIRES_IN,
      7 * 24 * 60 * 60,
    );

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: accessTokenExpiresIn,
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_REFRESH_SECRET,
      expiresIn: refreshTokenExpiresIn,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: accessTokenExpiresIn,
      tokenType: "Bearer",
    };
  }
}

/**
 * Convert a Nest-compatible JWT duration string to seconds. Accepts:
 *   - plain digits (e.g. "3600") → seconds as-is.
 *   - suffixed strings ("30s", "15m", "1h", "7d") → seconds.
 *   - undefined / blank → fallback default.
 */
function parseJwtDuration(
  raw: string | undefined,
  fallbackSeconds: number,
): number {
  if (!raw) return fallbackSeconds;
  const trimmed = raw.trim();
  if (!trimmed) return fallbackSeconds;
  const match = /^(\d+)\s*([smhd])?$/i.exec(trimmed);
  if (!match) return fallbackSeconds;
  const n = parseInt(match[1], 10);
  const unit = (match[2] || "s").toLowerCase();
  const mult =
    unit === "s"
      ? 1
      : unit === "m"
        ? 60
        : unit === "h"
          ? 60 * 60
          : 24 * 60 * 60;
  return n * mult;
}
