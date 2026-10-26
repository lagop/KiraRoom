import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../common/prisma/prisma.service";
import { ProductEventsService, PRODUCT_EVENTS } from "../common/telemetry/product-events.service";
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
import { EmailService } from "../notifications/services/email.service";
import { randomBytes } from "crypto";
import { normalizePlan } from "@kira/shared";
import {
  parseJwtDuration,
  DEFAULT_ACCESS_TOKEN_SECONDS,
  DEFAULT_REFRESH_TOKEN_SECONDS,
} from "../common/jwt-duration";
import { AuthSessionsService } from "./sessions/auth-sessions.service";
import { TwoFactorService } from "./two-factor/two-factor.service";

/** Audience of the short-lived token that stands between password and code. */
const TWO_FACTOR_AUDIENCE = "kira-2fa-login";
const TWO_FACTOR_CHALLENGE_SECONDS = 5 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 30 * 60 * 1000;

/** The password was right and the account asks for a code next. */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  /** Signed, 5 minutes; sent back with the code to POST /auth/2fa/verify. */
  challenge: string;
}

export interface TokenResponse {
  accessToken: string;
  /** Absent when a refresh inside the rotation grace window only renews access. */
  refreshToken?: string;
  /** Lifetime of refreshToken, for the cookie that carries it. */
  refreshExpiresIn?: number;
  expiresIn: number;
  tokenType: string;
}

/** How a new token pair relates to the sign-in it continues. */
type SessionOptions = { session?: { sid: string; jti: string }; accessOnly?: boolean };

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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditLog: AuditLogService,
    private readonly events: ProductEventsService,
    private readonly email: EmailService,
    private readonly sessions: AuthSessionsService,
    private readonly twoFactor: TwoFactorService,
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

    // Funnel entry point: everything else in the activation funnel is
    // measured relative to this event.
    this.events.record(PRODUCT_EVENTS.TENANT_SIGNED_UP, createdTenant.id, {
      language: registerDto.language ?? 'es',
    });

    // Welcome email with the verification link folded in (A3 + A4).
    // Registration used to send nothing: the first email a new salon ever
    // got was the trial-expiry warning on day 11, so a signup that did not
    // come back the next day received no nudge at all. The email columns for
    // verification already existed in the schema and the flow was never
    // built, so the token is minted here.
    //
    // Never blocks the signup: a bounced address or an unconfigured mail
    // provider must not stop a salon from getting into the product.
    void this.sendActivationEmail({
      userId: user.id,
      email: user.email,
      tenantName: registerDto.salonName,
      ownerName: firstName || null,
    }).catch((err: Error) => {
      this.logger.warn(`welcome email not sent: ${err.message}`);
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

  /** Token lifetime for the email-verification link. */
  private static readonly EMAIL_VERIFY_TTL_MS = 48 * 60 * 60 * 1000;

  private async sendActivationEmail(args: {
    userId: string;
    email: string;
    tenantName: string;
    ownerName: string | null;
  }): Promise<void> {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + AuthService.EMAIL_VERIFY_TTL_MS);

    await this.prisma.user.update({
      where: { id: args.userId },
      data: {
        emailVerificationToken: token,
        emailVerificationExpires: expiresAt,
      },
    });

    const frontendUrl = (
      process.env.FRONTEND_URL || "http://localhost:3000"
    ).replace(/\/$/, "");

    await this.email.sendWelcome({
      to: args.email,
      tenantName: args.tenantName,
      ownerName: args.ownerName,
      dashboardUrl: `${frontendUrl}/dashboard`,
      verifyUrl: `${frontendUrl}/verify-email?token=${token}`,
    });
  }

  /**
   * Confirms an email address from the link in the welcome email.
   *
   * Returns a boolean rather than throwing on a bad token: the caller is a
   * public endpoint, and telling an anonymous caller whether a token exists
   * is free information about who signed up.
   */
  async verifyEmail(token: string): Promise<boolean> {
    if (!token || token.length < 32) return false;

    const user = await this.prisma.user.findFirst({
      where: {
        emailVerificationToken: token,
        emailVerificationExpires: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!user) return false;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpires: null,
      },
    });
    return true;
  }

  async login(
    loginDto: LoginDto,
  ): Promise<{ user: AuthUser; tokens: TokenResponse } | TwoFactorChallenge> {
    // First, try to find user by email
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
      include: { professional: true },
    });

    if (user) {
      // Check if user is active
      if (!user.isActive) {
        throw new UnauthorizedException("Esta cuenta está desactivada. Pide acceso a quien gestiona el salón.");
      }

      // SEC-8: honour the lockout this method sets.
      //
      // The failed-password branch below has always written `lockedUntil`
      // 30 minutes out after 5 attempts, and nothing ever read it. The
      // lockout was decorative: the column filled up while bcrypt.compare
      // kept answering every guess. The only real limit was the global
      // throttle, 100 requests per minute, against an admin address an
      // attacker can guess.
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const minutes = Math.ceil(
          (user.lockedUntil.getTime() - Date.now()) / 60000,
        );
        throw new UnauthorizedException(
          `Account locked after too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
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

      // Two-step sign-in: the password was right, now the code. The failed
      // attempts are not reset here, so someone who has the password cannot
      // alternate it with code guesses: wrong codes count towards the same
      // lockout (see completeTwoFactorLogin).
      if (user.twoFactorEnabled) {
        return {
          twoFactorRequired: true,
          challenge: this.jwtService.sign(
            { sub: user.id, purpose: "2fa-login" },
            { audience: TWO_FACTOR_AUDIENCE, expiresIn: TWO_FACTOR_CHALLENGE_SECONDS },
          ),
        };
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

    // If not found as user, try to find as client -- in the salon whose site
    // this is, when the caller says which (see LoginDto.tenantSlug).
    const client = await this.prisma.client.findFirst({
      where: {
        email: loginDto.email,
        ...(loginDto.tenantSlug ? { tenant: { slug: loginDto.tenantSlug } } : {}),
      },
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

        if (!client || (payload.tv ?? 0) !== client.tokenVersion) {
          throw new UnauthorizedException("Invalid refresh token");
        }

        // Generate new tokens for client
        return this.generateTokens(
          client.id,
          client.email!,
          "client",
          client.tenantId,
          undefined,
          undefined,
          await this.continueSession(payload),
        );
      } else {
        // Find user by id
        const user = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          include: { professional: true },
        });

        // A token minted before a logout or password change carries an
        // older tv and stops refreshing.
        if (!user || !user.isActive || (payload.tv ?? 0) !== user.tokenVersion) {
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
          await this.continueSession(payload),
        );
      }
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  /**
   * Rotates the session a refresh token belongs to. A token issued before
   * sessions existed has no sid: it starts one, so the browsers signed in at
   * deploy time move to the cookie on their next refresh.
   */
  private async continueSession(payload: { sid?: string; jti?: string }): Promise<SessionOptions> {
    if (!payload.sid || !payload.jti) return {};
    const outcome = await this.sessions.rotate(payload.sid, payload.jti, this.refreshExpiry());
    return outcome.kind === "rotated"
      ? { session: { sid: payload.sid, jti: outcome.jti } }
      : { accessOnly: true };
  }

  private refreshTokenSeconds(): number {
    return parseJwtDuration(process.env.JWT_REFRESH_EXPIRES_IN, DEFAULT_REFRESH_TOKEN_SECONDS);
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.refreshTokenSeconds() * 1000);
  }

  /**
   * Ends every session of this account. It used to update the user with an
   * empty change -- revoking nothing, so a stolen token stayed valid until
   * it expired -- and failed outright for a client, whose id is not a user.
   * Bumping tokenVersion makes every token issued so far (access and
   * refresh, on every device) stop working.
   */
  /**
   * The second step of a sign-in with two-step verification: the challenge
   * from login plus a code from the app or a recovery code. Wrong codes count
   * as failed attempts, with the password's lockout (5, then 30 minutes).
   */
  async completeTwoFactorLogin(
    challenge: string,
    code: string,
  ): Promise<{ user: AuthUser; tokens: TokenResponse }> {
    let payload: { sub?: string; purpose?: string };
    try {
      payload = this.jwtService.verify(challenge ?? "", { audience: TWO_FACTOR_AUDIENCE });
    } catch {
      throw new UnauthorizedException("Han pasado más de 5 minutos. Vuelve a escribir la contraseña.");
    }
    if (payload.purpose !== "2fa-login" || !payload.sub) {
      throw new UnauthorizedException("Vuelve a escribir la contraseña.");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { professional: true },
    });
    if (!user || !user.isActive || !user.twoFactorEnabled) {
      throw new UnauthorizedException("Vuelve a escribir la contraseña.");
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(
        `Cuenta bloqueada por demasiados intentos. Vuelve a intentarlo en ${minutes} minuto${minutes === 1 ? "" : "s"}.`,
      );
    }

    if (!(await this.twoFactor.verifyForLogin(user.id, code))) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          loginAttempts: { increment: 1 },
          lockedUntil: user.loginAttempts >= MAX_LOGIN_ATTEMPTS - 1 ? new Date(Date.now() + LOCKOUT_MS) : null,
        },
      });
      throw new UnauthorizedException("El código no es correcto.");
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { loginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
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

  async logout(id: string, role?: string): Promise<void> {
    return this.logoutEverywhere(id, role);
  }

  /**
   * Ends the session of the browser that holds this refresh token (its
   * cookie), leaving the account's other devices signed in. Its access
   * token, already removed from the page, expires within minutes.
   */
  async endSession(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    try {
      const payload = this.jwtService.verify(refreshToken, { secret: process.env.JWT_REFRESH_SECRET });
      if (payload?.sid) await this.sessions.revoke(payload.sid);
    } catch {
      // An expired or forged token has no session worth ending.
    }
  }

  async logoutEverywhere(id: string, role?: string): Promise<void> {
    if (role === "client") {
      await this.prisma.client.update({ where: { id }, data: { tokenVersion: { increment: 1 } } });
      return;
    }
    await this.prisma.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } });
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
        // Consumed by /dashboard/settings, which used to show invented
        // values for all of these and save none of them.
        email: true,
        dateFormat: true,
        timeFormat: true,
        minCancelHours: true,
        openingHours: true,
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
    const data = { ...updateData };
    if (updateData.openingHours) {
      // getAvailableSlots builds every salon's grid from this window; a
      // reversed or empty one leaves the salon with no bookable slot at all,
      // silently.
      if (updateData.openingHours.open >= updateData.openingHours.close) {
        throw new BadRequestException("La hora de apertura debe ser anterior a la de cierre");
      }
      // Merge rather than replace: onboarding stores other keys in the same
      // JSON, and only { open, close } is edited from settings.
      const current = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { openingHours: true },
      });
      const existing =
        current?.openingHours && typeof current.openingHours === "object"
          ? (current.openingHours as Record<string, unknown>)
          : {};
      data.openingHours = {
        ...existing,
        open: updateData.openingHours.open,
        close: updateData.openingHours.close,
      };
    }
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data,
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
    sessionOptions: SessionOptions = {},
  ): Promise<TokenResponse> {
    // The account's session version, so logout and a password change can
    // end every token issued before them (see logout and JwtStrategy).
    const owner =
      role === "client"
        ? await this.prisma.client.findUnique({ where: { id: userId }, select: { tokenVersion: true } })
        : await this.prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } });

    const payload: Record<string, unknown> = {
      sub: userId,
      email,
      role,
      tenantId,
      tv: owner?.tokenVersion ?? 0,
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
    // "7d", "30s". Defaults: 15m access, 7d refresh (long enough that a
    // legitimate actively-used user never sees a forced re-login).
    const accessTokenExpiresIn = parseJwtDuration(
      process.env.JWT_EXPIRES_IN,
      DEFAULT_ACCESS_TOKEN_SECONDS,
    );
    const refreshTokenExpiresIn = this.refreshTokenSeconds();

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: accessTokenExpiresIn,
    });

    if (sessionOptions.accessOnly) {
      return { accessToken, expiresIn: accessTokenExpiresIn, tokenType: "Bearer" };
    }

    // A new sign-in starts a session; a refresh continues its own.
    const session =
      sessionOptions.session ??
      (await this.sessions.start(
        { id: userId, type: role === "client" ? "client" : "user" },
        new Date(Date.now() + refreshTokenExpiresIn * 1000),
      ));

    const refreshToken = this.jwtService.sign(
      { ...payload, sid: session.sid, jti: session.jti },
      {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: refreshTokenExpiresIn,
      },
    );

    return {
      accessToken,
      refreshToken,
      refreshExpiresIn: refreshTokenExpiresIn,
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
