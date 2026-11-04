import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../common/prisma/prisma.service";
import { ProductEventsService, PRODUCT_EVENTS } from "../common/telemetry/product-events.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { Prisma, UserRole } from "@prisma/client";
import {
  availableTenantSlug,
  createTenantWithOwner,
  getActiveTenant,
  hashPassword,
  TENANT_SLUG_UNAVAILABLE,
} from "../saas/saas.helpers";
import { normalizeEmail } from "./email-normalize";
import { tenantOwnerEmailVerified } from "./email-verified/owner-email-verified";
import { TERMS_LAST_UPDATED_LABEL, TERMS_VERSION } from "./legal-terms";
import { AuditLogService } from "../saas/audit-log.service";
import { EmailService } from "../notifications/services/email.service";
import { createHash, randomBytes } from "crypto";
import { isKnownSalonTimezone, normalizePlan, suggestedSalonTimezone } from "@kira/shared";
import {
  parseJwtDuration,
  DEFAULT_ACCESS_TOKEN_SECONDS,
  DEFAULT_REFRESH_TOKEN_SECONDS,
} from "../common/jwt-duration";
import { AuthSessionsService } from "./sessions/auth-sessions.service";
import {
  normalizeWorkingHours,
  weekFromOpeningPair,
  workingHoursProblem,
} from "../professionals/working-hours-input";
import { TwoFactorService } from "./two-factor/two-factor.service";
import { sessionRevocations } from "./sessions/session-revocations";
import { SALON_DELETED_MESSAGE } from "./salon-deleted";
import { fiscalSettingsForTerritory, territoryTaxRegime } from "../invoices/salon-tax-settings";

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

/**
 * What the panel gets of its own salon, from GET and PATCH /auth/tenant.
 * Never the Stripe keys, the channel credentials (features), the Stripe
 * customer/subscription ids or the fiscal and accounting settings: PATCH used
 * to answer the whole row, so every save on General sent them to the browser.
 */
export const TENANT_SETTINGS_SELECT = {
  id: true,
  name: true,
  slug: true,
  timezone: true,
  // Not currency, dateFormat or timeFormat: the product is euros, DD/MM/YYYY
  // and 24 h, and those settings changed nothing in the panel.
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
  coverImage: true,
  // Consumed by /dashboard/settings, which used to show invented
  // values for all of these and save none of them.
  email: true,
  // Informational: the receptionist explains them, nothing is charged.
  minCancelHours: true,
  cancellationPolicy: true,
  openingHours: true,
  instagram: true,
  facebook: true,
  // The public page's links (Ajustes > Salón).
  website: true,
  whatsapp: true,
  privacyPolicyUrl: true,
  bookingSlotMinutes: true,
  autoConfirmOnlineBookings: true,
  timeOffEmailNotices: true,
  // Ajustes > Recepcionista "Chat en mi web".
  webChatEnabled: true,
  // Tax identifiers (consumed by /dashboard/settings/fiscal).
  taxId: true,
  taxIdType: true,
  legalName: true,
} as const satisfies Prisma.TenantSelect;

/**
 * Two salons may share a name; the slug is what must be unique. Nothing on
 * the settings pages changes the slug (the DTO has no slug), but a caller
 * that skips the DTO gets a 409 for a clash, not a 500.
 */
export const TENANT_SLUG_TAKEN = "Ya hay otro salón con esa dirección en KiraRoom. Prueba con otra.";

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

/** Whether a Prisma unique-constraint error (P2002) is about this column. */
function targetIncludes(e: any, column: string): boolean {
  const target = e?.meta?.target;
  if (Array.isArray(target)) return target.includes(column);
  // Postgres reports the index name ("tenants_slug_key") on some paths.
  return typeof target === "string" ? target.includes(column) : true;
}

/** A sign-in with a wrong password, or with an address that has no account. */
export const INVALID_CREDENTIALS = "Email o contraseña incorrectos.";

/**
 * Signup with an address that already has an account, maybe as part of
 * another salon's team: the email is unique across KiraRoom (S11).
 */
export const EMAIL_ALREADY_REGISTERED =
  "Este email ya tiene una cuenta en KiraRoom (quizá como parte del equipo de otro salón). Inicia sesión o usa otro email para tu salón.";

/** Machine-readable code with EMAIL_ALREADY_REGISTERED, for the form's links. */
export const EMAIL_ALREADY_REGISTERED_CODE = "EMAIL_ALREADY_REGISTERED";

export function lockedMessage(lockedUntil: Date, now: number = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - now) / 60000));
  return `Demasiados intentos: la cuenta está bloqueada. Vuelve a intentarlo en ${minutes} minuto${minutes === 1 ? "" : "s"}.`;
}

/**
 * The write for one more failed attempt (password or code). A lock that has
 * already run out starts the count again; otherwise the attempts stayed at 5
 * after the 30 minutes and the next slip locked the account straight away.
 */
export function failedAttemptUpdate(
  user: { loginAttempts: number; lockedUntil: Date | null },
  now: number = Date.now(),
): { loginAttempts: number | { increment: number }; lockedUntil: Date | null } {
  const lockExpired = Boolean(user.lockedUntil && user.lockedUntil.getTime() <= now);
  const before = lockExpired ? 0 : user.loginAttempts;
  return {
    // An increment, so two wrong passwords at once both count; after an
    // expired lock the count starts again at this one.
    loginAttempts: lockExpired ? 1 : { increment: 1 },
    lockedUntil: before >= MAX_LOGIN_ATTEMPTS - 1 ? new Date(now + LOCKOUT_MS) : null,
  };
}

function emailAlreadyRegistered(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: EMAIL_ALREADY_REGISTERED,
    code: EMAIL_ALREADY_REGISTERED_CODE,
  });
}

/** sha256 of an email-verification token: what is stored (S14). */
export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A bcrypt hash with the configured cost, for a sign-in with an unknown
 * address: comparing against it takes as long as a real wrong password.
 */
let timingHashPromise: Promise<string> | null = null;
function timingHash(): Promise<string> {
  timingHashPromise ??= hashPassword(randomBytes(16).toString("hex"));
  return timingHashPromise;
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
    context: { ip?: string | null } = {},
  ): Promise<{ user: AuthUser; tokens: TokenResponse }> {
    // The DTO lower-cases the email; older rows may still have capitals
    // (the lower-casing migration leaves case-insensitive duplicates as
    // they were), so the check ignores case.
    const email = normalizeEmail(registerDto.email);
    const salonName = registerDto.salonName.trim();
    const existingUser = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });

    if (existingUser) {
      throw emailAlreadyRegistered();
    }
    // Only a language the panel has (es, en); anything else is Spanish.
    const language = registerDto.language === "en" ? "en" : "es";
    const phone = registerDto.phone?.trim() || null;

    // Tenant+owner creation goes through the SaaS helpers so the three
    // creation paths (signup form / SaaS-admin createTenant / invite
    // acceptance) stay in lockstep. Single source of truth for trial
    // length + bcrypt cost lives in saas.constants.ts.
    //
    // Two salons may share a name, so a name that is taken no longer stops
    // the signup ("Salon name already exists"): the salon gets the next free
    // address, "peluqueria-lucia-2". A signup that loses the race for that
    // address to another one at the same moment takes the next.

    // Parse ownerName into firstName and lastName (RegisterDto uses a
    // single ownerName field; CreateTenantDto uses ownerFirstName +
    // ownerLastName. auth.service.register handles the marketing-form path.)
    const nameParts = registerDto.ownerName.trim().split(/\s+/);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    const lostRace = new Set<string>();
    let created: Awaited<ReturnType<typeof createTenantWithOwner>> | undefined;
    for (let attempt = 0; !created; attempt++) {
      const slug = await availableTenantSlug(this.prisma, salonName, lostRace);
      try {
        created = await createTenantWithOwner(this.prisma, {
          name: salonName,
          slug,
          plan: "esencial",
          // The form asks for it (required): it is the salon's phone, which
          // the public page, reminders and invoices show and the "datos del
          // salón" checklist step looks for. It used to be dropped.
          phone,
          // The panel speaks Spanish and English; the owner's choice is the
          // salon's language and hers.
          language,
          ownerLanguage: language,
          ownerEmail: email,
          ownerPassword: registerDto.password,
          ownerFirstName: firstName,
          ownerLastName: lastName,
          // The browser's zone at sign-up, when it is one a salon can be in: a
          // salon signing up from Las Palmas starts on Canary time instead of
          // Madrid's. Onboarding's address step corrects the rest.
          timezone: isKnownSalonTimezone(registerDto.timezone) ? registerDto.timezone : undefined,
          // The terms (with the art. 28 processing agreement) and the privacy
          // policy, accepted on the form: recorded with the salon, atomically.
          legalAcceptance: { termsVersion: TERMS_VERSION, ip: context.ip ?? null, source: "signup" },
        });
      } catch (e: any) {
        if (e?.code !== "P2002") throw e;
        // The owner's email, registered by a signup a moment ago.
        const target = e?.meta?.target;
        if (Array.isArray(target) ? target.includes("email") : String(target ?? "").includes("email")) {
          throw emailAlreadyRegistered();
        }
        if (!targetIncludes(e, "slug")) throw e;
        if (attempt >= 4) throw new ConflictException(TENANT_SLUG_UNAVAILABLE);
        lostRace.add(slug);
      }
    }
    const { tenant: createdTenant, user } = created;

    // Funnel entry point: everything else in the activation funnel is
    // measured relative to this event.
    this.events.record(PRODUCT_EVENTS.TENANT_SIGNED_UP, createdTenant.id, {
      language,
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
      tenantName: salonName,
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

  /**
   * A new verification link for this user: only its sha256 is stored, like
   * the password-reset link, so a copy of the database confirms nothing.
   */
  private async mintEmailVerificationToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + AuthService.EMAIL_VERIFY_TTL_MS);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerificationToken: hashVerificationToken(token),
        emailVerificationExpires: expiresAt,
      },
    });
    return { token, expiresAt };
  }

  private frontendUrl(): string {
    return (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
  }

  private async sendActivationEmail(args: {
    userId: string;
    email: string;
    tenantName: string;
    ownerName: string | null;
  }): Promise<void> {
    const { token } = await this.mintEmailVerificationToken(args.userId);
    const frontendUrl = this.frontendUrl();

    await this.email.sendWelcome({
      to: args.email,
      tenantName: args.tenantName,
      ownerName: args.ownerName,
      dashboardUrl: `${frontendUrl}/dashboard`,
      verifyUrl: `${frontendUrl}/verify-email?token=${token}`,
    });
  }

  /**
   * D3: whether the panel must ask this user to accept the current terms.
   * Only an owner is asked (not support signed in as the salon), and only
   * while the salon has no acceptance of TERMS_VERSION: salons from before
   * acceptances were recorded, and all of them again when the version moves.
   */
  async termsStatus(user: {
    id: string;
    role: string;
    impersonatedBy?: string;
  }): Promise<{ required: boolean; version: string; lastUpdated: string }> {
    const answer = (required: boolean) => ({ required, version: TERMS_VERSION, lastUpdated: TERMS_LAST_UPDATED_LABEL });
    if (user.role !== "owner" || user.impersonatedBy) return answer(false);
    const row = await this.prisma.user.findUnique({ where: { id: user.id }, select: { tenantId: true } });
    if (!row) return answer(false);
    const accepted = await this.prisma.legalAcceptance.count({
      where: { tenantId: row.tenantId, termsVersion: TERMS_VERSION },
    });
    return answer(accepted === 0);
  }

  /** D3: records the owner's acceptance of the current terms. Once per version. */
  async acceptCurrentTerms(userId: string, ip: string | null): Promise<{ accepted: true; version: string }> {
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true, role: true } });
    if (!row || row.role !== "owner") {
      throw new ForbiddenException("Solo la dueña del salón puede aceptar los términos.");
    }
    const already = await this.prisma.legalAcceptance.count({
      where: { tenantId: row.tenantId, termsVersion: TERMS_VERSION },
    });
    if (already === 0) {
      await this.prisma.legalAcceptance.create({
        data: {
          tenantId: row.tenantId,
          acceptedByUserId: userId,
          termsVersion: TERMS_VERSION,
          ip,
          source: "login_prompt",
        },
      });
    }
    return { accepted: true, version: TERMS_VERSION };
  }

  /**
   * Whether the signed-in user's email is confirmed (for the panel's notice),
   * and whether the salon has an owner with a confirmed email: until it has,
   * campaigns, mass sends and Stripe are blocked (D1, VerifiedOwnerEmailGuard).
   */
  async emailVerificationStatus(
    userId: string,
  ): Promise<{ verified: boolean; email: string | null; salonVerified: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isEmailVerified: true, email: true, tenantId: true },
    });
    const salonVerified = user ? await tenantOwnerEmailVerified(this.prisma, user.tenantId) : false;
    return { verified: Boolean(user?.isEmailVerified), email: user?.email ?? null, salonVerified };
  }

  /**
   * POST /auth/resend-verification: a new link for the signed-in user (the
   * controller limits how often). The old link stops working, since only
   * one token is kept. Already confirmed: nothing is sent.
   */
  async resendVerificationEmail(userId: string): Promise<{ sent: boolean; alreadyVerified: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        isEmailVerified: true,
        isActive: true,
        tenant: { select: { name: true } },
      },
    });
    if (!user || !user.isActive) throw new NotFoundException();
    if (user.isEmailVerified) return { sent: false, alreadyVerified: true };

    const { token, expiresAt } = await this.mintEmailVerificationToken(user.id);
    const result = await this.email.sendEmailVerification({
      to: user.email,
      tenantName: user.tenant?.name ?? "KiraRoom",
      ownerName: user.firstName || null,
      verifyUrl: `${this.frontendUrl()}/verify-email?token=${token}`,
      expiresAt,
    });
    if (!result?.success) {
      this.logger.warn(`verification email not sent: ${result?.error ?? "unknown"}`);
      return { sent: false, alreadyVerified: false };
    }
    return { sent: true, alreadyVerified: false };
  }

  /**
   * Confirms an email address from the link in the welcome email.
   *
   * Returns a boolean rather than throwing on a bad token: the caller is a
   * public endpoint, and telling an anonymous caller whether a token exists
   * is free information about who signed up.
   *
   * The link's token is looked up by its sha256. Links sent before tokens
   * were hashed stored the token itself; they are still matched as they are
   * until they expire (48 hours after they were sent), so nobody's welcome
   * link breaks on the deploy. After that window the plain-token branch
   * matches nothing new and can be removed.
   */
  async verifyEmail(token: string): Promise<boolean> {
    if (!token || token.length < 32 || token.length > 128) return false;

    const user = await this.prisma.user.findFirst({
      where: {
        emailVerificationToken: { in: [hashVerificationToken(token), token] },
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

  /**
   * The account a sign-in names. Emails are stored lower-case (the DTO
   * normalises them and a migration lower-cased the old rows), so an exact
   * match is the rule. The migration left alone the rows whose lower-case
   * form would collide with another account's; those are found ignoring
   * case, and when there are several the password decides which it is.
   */
  private async loginCandidates(email: string) {
    const exact = await this.prisma.user.findUnique({
      where: { email },
      include: { professional: true, tenant: { select: { deletedAt: true } } },
    });
    if (exact) return [exact];
    return (
      (await this.prisma.user.findMany({
        where: { email: { equals: email, mode: "insensitive" } },
        include: { professional: true, tenant: { select: { deletedAt: true } } },
        orderBy: { lastLoginAt: { sort: "desc", nulls: "last" } },
        take: 5,
      })) ?? []
    );
  }

  async login(
    loginDto: LoginDto,
  ): Promise<{ user: AuthUser; tokens: TokenResponse } | TwoFactorChallenge> {
    const email = normalizeEmail(loginDto.email);
    const candidates = await this.loginCandidates(email);

    // The password is checked before anything about the account is said
    // (deactivated, locked): with a wrong password the answer is the same as
    // for an address with no account, so a stranger learns nothing.
    let user = candidates[0];
    let isPasswordValid = false;
    for (const candidate of candidates) {
      if (await bcrypt.compare(loginDto.password ?? "", candidate.passwordHash)) {
        user = candidate;
        isPasswordValid = true;
        break;
      }
    }

    if (user) {
      const now = new Date();
      // SEC-8: the lockout is honoured (it used to be written and never
      // read). A lock still running stops even the right password, below.
      const lockRunning = Boolean(user.lockedUntil && user.lockedUntil > now);

      if (!isPasswordValid) {
        // A locked or deactivated account does not count more failures: a
        // caller cannot extend a lock by guessing on during it.
        if (!lockRunning && user.isActive) {
          // A lock that has run out starts the count again (S10): the next
          // wrong password used to lock the account straight away, since the
          // attempts stayed at 5 after the 30 minutes.
          await this.prisma.user.update({
            where: { id: user.id },
            data: failedAttemptUpdate(user, now.getTime()),
          });
        }
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }

      // The password is right: now the account's state can be told.
      // A salon deleted from the platform console: nobody in it signs in.
      if (user.tenant?.deletedAt && user.role !== UserRole.saas_owner) {
        throw new UnauthorizedException(SALON_DELETED_MESSAGE);
      }
      if (!user.isActive) {
        throw new UnauthorizedException("Esta cuenta está desactivada. Pide acceso a quien gestiona el salón.");
      }
      if (lockRunning) {
        throw new UnauthorizedException(lockedMessage(user.lockedUntil!));
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

    // Clients have no accounts: the salon's site has no sign-in any more and
    // nothing signs a client in, whatever password her record may still
    // hold from before. (Their data stays; only the sign-in went.)
    // Same time as a wrong password, so the answer does not say whether the
    // address has an account.
    await bcrypt.compare(loginDto.password ?? "", await timingHash());
    throw new UnauthorizedException(INVALID_CREDENTIALS);
  }

  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });

      if (payload.role === "client") {
        // Client sessions from before client accounts were removed end here.
        throw new UnauthorizedException("Invalid refresh token");
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
      throw new UnauthorizedException(lockedMessage(user.lockedUntil));
    }

    if (!(await this.twoFactor.verifyForLogin(user.id, code))) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          ...failedAttemptUpdate(user),
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

  /**
   * A panel user (owner, admin or professional) changing their own
   * password. There was no way to: a professional kept the first password
   * the owner chose and handed over.
   *
   * It takes the current password, so a borrowed session is not enough to
   * lock the owner of the account out; wrong guesses count towards the
   * sign-in lockout. Every session ends (tokenVersion), as with a reset, and
   * this browser gets a new one, so the person changing it stays signed in.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ user: AuthUser; tokens: TokenResponse }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { professional: { select: { id: true } } },
    });
    if (!user || !user.isActive) throw new UnauthorizedException();
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new BadRequestException(lockedMessage(user.lockedUntil));
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          ...failedAttemptUpdate(user),
        },
      });
      // 400, not 401: the panel treats a 401 as an expired session and signs
      // out, which would punish a typo.
      throw new BadRequestException("La contraseña actual no es correcta.");
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException("La contraseña nueva tiene que ser distinta de la actual.");
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, Number(process.env.BCRYPT_ROUNDS) || 12),
        tokenVersion: { increment: 1 },
        loginAttempts: 0,
        lockedUntil: null,
      },
    });
    // The other sessions' live sockets close now; this browser reconnects
    // with the tokens below.
    sessionRevocations.revoke({ userId: user.id });
    return this.sessionAfterSignInChange(user.id);
  }

  /**
   * A new session for the browser that just changed how the account signs in
   * (its password, two-step verification). The caller has already raised
   * tokenVersion, which ended every session, this browser's included; this
   * one goes on with the tokens answered here.
   */
  async sessionAfterSignInChange(userId: string): Promise<{ user: AuthUser; tokens: TokenResponse }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { professional: { select: { id: true } } },
    });
    if (!user || !user.isActive) throw new UnauthorizedException();
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

  async logoutEverywhere(id: string, role?: string): Promise<void> {
    if (role === "client") {
      await this.prisma.client.update({ where: { id }, data: { tokenVersion: { increment: 1 } } });
      sessionRevocations.revoke({ clientId: id });
      return;
    }
    await this.prisma.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } });
    sessionRevocations.revoke({ userId: id });
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
      select: TENANT_SETTINGS_SELECT,
    });

    if (!tenant) {
      throw new UnauthorizedException("Tenant not found");
    }

    return tenant;
  }

  async updateTenant(tenantId: string, updateData: any) {
    const data = { ...updateData };
    // The salon's own week, in the list format of a professional's
    // workingHours. The DTO already normalised and validated it
    // (@IsWorkingHours); done again here for callers that skip the DTO. A
    // legacy { open, close } becomes that window every day. It replaces the
    // whole value: the old merge kept the onboarding wizard's day keys next
    // to { open, close }, which nothing reads once the week itself is here.
    if (updateData.openingHours === undefined || updateData.openingHours === null) {
      delete data.openingHours;
    } else {
      const week = normalizeWorkingHours(weekFromOpeningPair(updateData.openingHours));
      const problem = workingHoursProblem(week);
      if (problem) throw new BadRequestException(problem);
      data.openingHours = week;
    }
    const timezone = await this.timezoneForAddressChange(tenantId, updateData);
    if (timezone) data.timezone = timezone;
    const fiscalSettings = await this.fiscalSettingsForAddressChange(tenantId, updateData, data.timezone);
    if (fiscalSettings) data.fiscalSettings = fiscalSettings;
    try {
      // The same shape as GET /auth/tenant, never the whole row (secrets).
      return await this.prisma.tenant.update({
        where: { id: tenantId },
        data,
        select: TENANT_SETTINGS_SELECT,
      });
    } catch (e: any) {
      if (e?.code === "P2002" && targetIncludes(e, "slug")) throw new ConflictException(TENANT_SLUG_TAKEN);
      throw e;
    }
  }

  /**
   * Canary time for a salon whose new address is in the Canary Islands while
   * it is still on Madrid's, the zone every sign-up started on; else null.
   * A zone sent in the same request, or any other zone, is left alone.
   */
  private async timezoneForAddressChange(
    tenantId: string,
    update: { timezone?: string; street?: string; city?: string; postalCode?: string; state?: string },
  ): Promise<string | null> {
    if (update.timezone !== undefined) return null;
    if ([update.street, update.city, update.postalCode, update.state].every((v) => v === undefined)) return null;
    const current = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true, street: true, city: true, postalCode: true, state: true, country: true },
    });
    if (!current) return null;
    const suggested = suggestedSalonTimezone(current.timezone, {
      street: update.street ?? current.street,
      city: update.city ?? current.city,
      postalCode: update.postalCode ?? current.postalCode,
      state: update.state ?? current.state,
      country: current.country,
    });
    if (suggested) this.logger.log(`tenant ${tenantId}: address in the Canary Islands, timezone set to ${suggested}`);
    return suggested;
  }

  /**
   * IGIC 7 % for a salon whose new address is in the Canary Islands (or that
   * moved to Canary time), IPSI for Ceuta and Melilla, while it is still on
   * another regime and has issued no invoice yet: its invoices would say
   * 21 % "IVA" otherwise (audit 7 N6). With invoices issued the regime is
   * the owner's to change in Ajustes fiscales; the panel says so
   * (GET /invoices/settings/fiscal territoryTaxRegime). Else null.
   */
  private async fiscalSettingsForAddressChange(
    tenantId: string,
    update: { timezone?: string; street?: string; city?: string; postalCode?: string; state?: string; fiscalSettings?: unknown },
    newTimezone: string | undefined,
  ): Promise<Record<string, unknown> | null> {
    if (update.fiscalSettings !== undefined) return null;
    if ([update.street, update.city, update.postalCode, update.state, newTimezone].every((v) => v === undefined)) return null;
    const current = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true, street: true, city: true, postalCode: true, state: true, country: true, fiscalSettings: true },
    });
    if (!current) return null;
    const regime = territoryTaxRegime(
      {
        street: update.street ?? current.street,
        city: update.city ?? current.city,
        postalCode: update.postalCode ?? current.postalCode,
        state: update.state ?? current.state,
        country: current.country,
      },
      newTimezone ?? current.timezone,
    );
    // Only when the territory itself changes: an owner who chose another
    // regime in Ajustes fiscales keeps it when she saves her address again.
    const before = territoryTaxRegime(current, current.timezone);
    if (regime === before) return null;
    const next = fiscalSettingsForTerritory(current.fiscalSettings, regime);
    if (!next) return null;
    const invoices = await this.prisma.invoice.count({ where: { tenantId } });
    if (invoices > 0) {
      this.logger.log(`tenant ${tenantId}: address in an ${regime} territory, but it has invoices: regime left as it is`);
      return null;
    }
    this.logger.log(`tenant ${tenantId}: address in an ${regime} territory, tax regime set to ${regime}`);
    return next;
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
