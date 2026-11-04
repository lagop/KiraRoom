import { Throttle } from "@nestjs/throttler";
import { PasswordResetService } from "./password-reset.service";
import { ChangeOwnPasswordDto, ForgotPasswordDto, ResetPasswordDto } from "./dto/password-reset.dto";
import {
  BadRequestException,
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpException,
  HttpStatus,
  Get,
  Patch,
  Query,
  Req,
  Res,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth } from "@nestjs/swagger";
import { AuthService, AuthUser, TokenResponse, TwoFactorChallenge } from "./auth.service";
import { TwoFactorService } from "./two-factor/two-factor.service";
import { TwoFactorCodeDto, TwoFactorDisableDto, TwoFactorVerifyDto } from "./two-factor/two-factor.dto";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { Public } from "./decorators/public.decorator";
import { Roles } from "./decorators/roles.decorator";
import { CurrentUser } from "./decorators/current-user.decorator";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "./guards/roles.guard";
import { UserRole } from "@prisma/client";
import { IMPERSONATION_AUDIENCE } from "../saas/saas.constants";
import { SignedIn } from "./decorators/signed-in.decorator";
import { AllowWhenReadOnly } from "../common/decorators/allow-when-read-only.decorator";
import {
  CookieKind,
  clearRefreshCookie,
  cookieKindForRole,
  deliverTokens,
  readRefreshCookie,
  supportCookieKind,
} from "./sessions/refresh-cookie";
import { ImpersonateDto, LogoutDto, RefreshTokenDto } from "./dto/session-bodies.dto";
import { TurnstileService, CAPTCHA_MESSAGE, CAPTCHA_REQUIRED_CODE } from "./abuse/turnstile.service";
import { AuthRateLimitsService } from "./abuse/auth-rate-limits.service";
import { isDisposableEmail } from "./abuse/disposable-email-domains";
import { normalizeEmail } from "./email-normalize";
import { AcceptTermsDto } from "./dto/accept-terms.dto";

/** The caller's address, as Express derives it behind the trusted proxies. */
function clientIp(req: Request | undefined): string | null {
  return req?.ip ?? req?.socket?.remoteAddress ?? null;
}

export const DISPOSABLE_EMAIL_MESSAGE =
  "No admitimos direcciones de email temporales. Usa el email que consultas a diario: ahí te llegarán los avisos del salón.";
export const TOO_MANY_SIGNUPS_MESSAGE =
  "Se han creado demasiadas cuentas seguidas desde aquí. Espera un rato y vuelve a probar, o escríbenos.";
export const TOO_MANY_VERIFICATION_EMAILS =
  "Ya te hemos enviado varios emails de confirmación en la última hora. Revisa también la carpeta de spam y vuelve a probar más tarde.";

function captchaRequired(message: string = CAPTCHA_MESSAGE): UnauthorizedException {
  return new UnauthorizedException({ statusCode: 401, message, code: CAPTCHA_REQUIRED_CODE });
}

function deliverSession(res: Response, result: { user: AuthUser; tokens: TokenResponse }) {
  return { ...result, tokens: deliverTokens(res, cookieKindForRole(result.user.role), result.tokens) };
}

/** Signed out of nothing yet: a challenge carries no session, so no cookie. */
function deliverLogin(res: Response, result: { user: AuthUser; tokens: TokenResponse } | TwoFactorChallenge) {
  return "twoFactorRequired" in result ? result : deliverSession(res, result);
}

/** Panel accounts only; a salon's clients have no accounts (and no token gets this far). */
function staffOnly(user: { role: string }) {
  if (user.role === "client") throw new ForbiddenException();
}

/**
 * Support signed in as the salon (impersonation) must not set up, turn on or
 * off two-step verification, nor replace the recovery codes: it could lock
 * the owner out of her own account. Same rule as the password change.
 */
function supportCannotTouchTwoFactor(user: { impersonatedBy?: string }) {
  if (user.impersonatedBy) {
    throw new ForbiddenException("No se puede cambiar la verificación en dos pasos desde una sesión de soporte.");
  }
}

type PanelUser = { id: string; role: string; impersonatedBy?: string };

@ApiTags("Authentication")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly twoFactor: TwoFactorService,
    private readonly turnstile: TurnstileService,
    private readonly limits: AuthRateLimitsService,
  ) {}

  /**
   * Emails a reset link if an account uses this address. Always the same
   * answer, so the endpoint does not tell who has an account.
   */
  @Public()
  @Post("forgot-password")
  // 5 per 15 min per IP here; per destination address, 3 an hour in Redis
  // (PasswordResetService).
  @Throttle({ default: { ttl: 900_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Email a password reset link" })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req?: Request) {
    if ((await this.turnstile.verify(dto.turnstileToken, clientIp(req))) !== "ok") {
      throw new BadRequestException(CAPTCHA_MESSAGE);
    }
    await this.passwordReset.request(dto.email, dto.tenantSlug);
    return { message: "Si hay una cuenta con ese email, te hemos enviado un enlace para restablecer la contraseña." };
  }

  @Public()
  @Post("reset-password")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Set a new password with the emailed token" })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.passwordReset.reset(dto.token, dto.password);
    return { message: "Contraseña cambiada. Ya puedes iniciar sesión." };
  }

  @Public()
  @Get("verify-email")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Confirm an email address from the welcome email link" })
  @ApiResponse({ status: 200, description: "Verification outcome" })
  async verifyEmail(@Query("token") token?: string) {
    // Deliberately the same response either way: whether a token exists
    // tells an anonymous caller who signed up. The frontend decides what
    // to show from the boolean.
    const verified = await this.authService.verifyEmail(token ?? "");
    return { verified };
  }

  /** D3: whether the panel asks the owner to accept the updated terms. */
  @Get("terms")
  @SignedIn()
  @AllowWhenReadOnly()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Whether the signed-in owner must accept the current terms" })
  async termsStatus(@CurrentUser() user: PanelUser) {
    staffOnly(user);
    return this.authService.termsStatus(user);
  }

  /** D3: "He leído y acepto los términos actualizados". Owner only, not support. */
  @Post("terms/accept")
  @SignedIn()
  @AllowWhenReadOnly()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Accept the current terms (owner)" })
  async acceptTerms(@CurrentUser() user: PanelUser, @Body() _dto: AcceptTermsDto, @Req() req: Request) {
    staffOnly(user);
    if (user.impersonatedBy) {
      throw new ForbiddenException("Los términos los acepta la dueña del salón, no una sesión de soporte.");
    }
    return this.authService.acceptCurrentTerms(user.id, clientIp(req));
  }

  /** Whether the signed-in user's email is confirmed: the panel's "Confirma tu email" notice. */
  @Get("email-verification")
  @SignedIn()
  @AllowWhenReadOnly()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Whether the signed-in user's email address is confirmed" })
  async emailVerification(@CurrentUser() user: PanelUser) {
    staffOnly(user);
    return this.authService.emailVerificationStatus(user.id);
  }

  /**
   * A new confirmation link for the signed-in user, by email. At most 3 an
   * hour per account (Redis). Until the owner confirms, campaigns, mass
   * sends and Stripe stay blocked (D1); this lets them get a new link.
   */
  @Post("resend-verification")
  @SignedIn()
  @AllowWhenReadOnly()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Email the signed-in user a new email-confirmation link (3 an hour)" })
  async resendVerification(@CurrentUser() user: PanelUser) {
    staffOnly(user);
    // Support signed in as the salon is not the owner checking her inbox.
    if (user.impersonatedBy) {
      throw new ForbiddenException("No se puede pedir el email de confirmación desde una sesión de soporte.");
    }
    const status = await this.authService.emailVerificationStatus(user.id);
    if (status.verified) return { sent: false, alreadyVerified: true };
    if (!(await this.limits.allowVerificationResend(user.id))) {
      throw new HttpException(TOO_MANY_VERIFICATION_EMAILS, HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.authService.resendVerificationEmail(user.id);
  }

  @Public()
  @Post("register")
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } }) // 5 sign-ups an hour per IP, in memory
  @ApiOperation({ summary: "Register a new tenant with owner account" })
  @ApiResponse({ status: 201, description: "Successfully registered" })
  @ApiResponse({ status: 409, description: "Email already registered" })
  @ApiResponse({ status: 400, description: "Invalid input, disposable email or captcha not passed" })
  @ApiResponse({ status: 429, description: "Too many signups from this IP or email domain" })
  async register(
    @Body() registerDto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
    @Req() req?: Request,
  ) {
    const ip = clientIp(req);
    // Cloudflare Turnstile, when configured (TURNSTILE_SECRET_KEY).
    if ((await this.turnstile.verify(registerDto.turnstileToken, ip)) !== "ok") {
      throw new BadRequestException(CAPTCHA_MESSAGE);
    }
    if (isDisposableEmail(registerDto.email)) {
      throw new BadRequestException(DISPOSABLE_EMAIL_MESSAGE);
    }
    // Per IP and per email domain, in Redis: the throttle above lives in
    // this process's memory and starts again on every deploy.
    if (await this.limits.signupAttempt(ip, normalizeEmail(registerDto.email))) {
      throw new HttpException(TOO_MANY_SIGNUPS_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }
    return deliverSession(res, await this.authService.register(registerDto, { ip }));
  }

  @Public()
  @Post("login")
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // with the per-account lockout
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Login and get access/refresh tokens" })
  @ApiResponse({ status: 200, description: "Successfully logged in" })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  async login(@Body() loginDto: LoginDto, @Res({ passthrough: true }) res: Response, @Req() req?: Request) {
    const ip = clientIp(req);
    const email = normalizeEmail(loginDto.email);
    // After 3 failed sign-ins for this email (or 10 from this IP) in an
    // hour, the form must also pass Turnstile. Only when it is configured.
    if (this.turnstile.isEnabled() && (await this.limits.loginNeedsCaptcha(email, ip))) {
      if ((await this.turnstile.verify(loginDto.turnstileToken, ip)) !== "ok") throw captchaRequired();
    }
    let result: Awaited<ReturnType<AuthService["login"]>>;
    try {
      result = await this.authService.login(loginDto, { ip });
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        const needsCaptcha = await this.limits.loginFailed(email, ip);
        // Same message; the code tells the form to show the captcha next time.
        if (needsCaptcha && this.turnstile.isEnabled()) throw captchaRequired(err.message);
      }
      throw err;
    }
    await this.limits.loginSucceeded(email);
    return deliverLogin(res, result);
  }

  /** Second step of a sign-in with two-step verification. */
  @Public()
  @Post("2fa/verify")
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // with the per-account lockout
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Finish a sign-in with a code from the authenticator app or a recovery code" })
  async verifyTwoFactor(@Body() dto: TwoFactorVerifyDto, @Res({ passthrough: true }) res: Response) {
    return deliverSession(res, await this.authService.completeTwoFactorLogin(dto.challenge, dto.code));
  }

  @Get("2fa")
  @SignedIn()
  @AllowWhenReadOnly()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Whether two-step verification is on for the signed-in user" })
  async twoFactorStatus(@CurrentUser() user: { id: string; role: string }) {
    staffOnly(user);
    return this.twoFactor.status(user.id);
  }

  @Post("2fa/setup")
  @SignedIn()
  @AllowWhenReadOnly()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Start turning on two-step verification: a secret for the authenticator app" })
  async twoFactorSetup(@CurrentUser() user: PanelUser) {
    staffOnly(user);
    supportCannotTouchTwoFactor(user);
    return this.twoFactor.setup(user.id);
  }

  @Post("2fa/enable")
  @SignedIn()
  @AllowWhenReadOnly()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Confirm the app with its first code; answers the recovery codes once. Other sessions end; this browser gets new tokens",
  })
  async twoFactorEnable(
    @CurrentUser() user: PanelUser,
    @Body() dto: TwoFactorCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    staffOnly(user);
    supportCannotTouchTwoFactor(user);
    const result = await this.twoFactor.enable(user.id, dto.code);
    return { ...result, ...(await this.renewSession(user, req, res)) };
  }

  @Post("2fa/disable")
  @SignedIn()
  @AllowWhenReadOnly()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Turn two-step verification off (password and a code). Other sessions end; this browser gets new tokens",
  })
  async twoFactorDisable(
    @CurrentUser() user: PanelUser,
    @Body() dto: TwoFactorDisableDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    staffOnly(user);
    supportCannotTouchTwoFactor(user);
    const result = await this.twoFactor.disable(user.id, dto.password, dto.code);
    return { ...result, ...(await this.renewSession(user, req, res)) };
  }

  @Post("2fa/recovery-codes")
  @SignedIn()
  @AllowWhenReadOnly()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "New recovery codes, replacing the old ones (needs a code)" })
  async twoFactorRecoveryCodes(@CurrentUser() user: PanelUser, @Body() dto: TwoFactorCodeDto) {
    staffOnly(user);
    supportCannotTouchTwoFactor(user);
    return this.twoFactor.regenerateRecoveryCodes(user.id, dto.code);
  }

  /**
   * After two-step verification was turned on or off every session ended
   * (tokenVersion); this browser's record is closed and it gets a new one,
   * as after a password change, so the person who did it stays signed in.
   */
  private async renewSession(user: PanelUser, req: Request, res: Response) {
    await this.authService.endSession(readRefreshCookie(req, cookieKindForRole(user.role)));
    return deliverSession(res, await this.authService.sessionAfterSignInChange(user.id));
  }

  /**
   * A panel user changes their own password (current + new). Every other
   * session ends; this browser gets new tokens (refresh cookie + access
   * token in the body), so it stays signed in.
   */
  @Patch("password")
  @SignedIn()
  @AllowWhenReadOnly()
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // with the per-account lockout
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Change the signed-in panel user's own password" })
  @ApiResponse({ status: 200, description: "Changed; new tokens for this browser" })
  @ApiResponse({ status: 400, description: "Wrong current password, or a new one that is not valid" })
  async changeOwnPassword(
    @CurrentUser() user: { id: string; role: string; impersonatedBy?: string },
    @Body() dto: ChangeOwnPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Panel accounts only: a salon's clients have no accounts.
    staffOnly(user);
    // Support signed in as the salon must not change the owner's password.
    if (user.impersonatedBy) {
      throw new ForbiddenException("No se puede cambiar la contraseña desde una sesión de soporte.");
    }
    const kind = cookieKindForRole(user.role);
    const result = await this.authService.changeOwnPassword(user.id, dto.currentPassword, dto.newPassword);
    // The session this browser had is over (tokenVersion); end its record too.
    await this.authService.endSession(readRefreshCookie(req, kind));
    return deliverSession(res, result);
  }

  @Public()
  @Post("impersonate")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Consume a SaaS-owner impersonation token and exchange it for a real session as the tenant owner. Writes an AuditLog row." })
  @ApiResponse({ status: 200, description: "Impersonation session minted" })
  @ApiResponse({ status: 401, description: "Invalid or expired token" })
  async impersonate(
    @Body() body: ImpersonateDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The reason is the one signed into the token in the console (C17); a
    // reason in the body is ignored.
    const result = await this.authService.impersonate(body.token, IMPERSONATION_AUDIENCE);
    // Its own cookie (C10): the platform owner's console session, in
    // kr_session, stays as it is, so entering a salon does not sign them out.
    const kind = supportCookieKind(result.support.tenantId);
    return { ...result, tokens: deliverTokens(res, kind, result.tokens) };
  }

  @Public()
  @Post("refresh")
  @AllowWhenReadOnly()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Refresh access token using refresh token" })
  @ApiResponse({ status: 200, description: "Successfully refreshed token" })
  @ApiResponse({ status: 401, description: "Invalid refresh token" })
  /**
   * The refresh token comes from its cookie; `kind: "client"` says a salon
   * site is asking, so the client's cookie is read and set. A token in the
   * body is a browser that signed in before the cookie existed (it kept it in
   * localStorage): it is accepted once more and moves to the cookie.
   */
  async refreshToken(
    @Body() body: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // "support" + tenantId: the tab where the platform owner is inside that
    // salon, with that salon's support cookie (C10).
    const supportTenantId = body?.kind === "support" && body.tenantId ? body.tenantId : undefined;
    if (body?.kind === "support" && !supportTenantId) throw new UnauthorizedException("Invalid refresh token");
    const kind: CookieKind = supportTenantId
      ? supportCookieKind(supportTenantId)
      : body?.kind === "client"
        ? "client"
        : "staff";
    const token =
      readRefreshCookie(req, kind) ??
      (!supportTenantId && typeof body?.refreshToken === "string" ? body.refreshToken : undefined);
    if (!token) throw new UnauthorizedException("Invalid refresh token");
    try {
      return deliverTokens(res, kind, await this.authService.refreshToken(token, { supportTenantId }));
    } catch (err) {
      if (err instanceof UnauthorizedException) clearRefreshCookie(res, kind);
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post("logout")
  @AllowWhenReadOnly()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Logout and invalidate tokens" })
  @ApiResponse({ status: 200, description: "Successfully logged out" })
  @SignedIn()
  /**
   * Signs this browser out: its session is revoked and its cookie cleared.
   * `everywhere: true` also ends every other session of the account.
   * Until the cookie existed the panel never called this (it only emptied
   * localStorage); now it must, or the next page load would renew the
   * session from the cookie.
   */
  async logout(
    @CurrentUser() user: { id: string; role: string; impersonatedBy?: string; impersonatedTenantId?: string; impersonationId?: string },
    @Body() body: LogoutDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // A support session ends alone: its own cookie, and never the owner's
    // other sessions ("everywhere" is the owner's to use, not support's).
    if (user.impersonatedBy && user.impersonatedTenantId) {
      const kind = supportCookieKind(user.impersonatedTenantId);
      await this.authService.endSupportSession(readRefreshCookie(req, kind), user);
      clearRefreshCookie(res, kind);
      return { message: "Successfully logged out" };
    }
    const kind = cookieKindForRole(user.role);
    await this.authService.endSession(readRefreshCookie(req, kind));
    if (body?.everywhere === true) await this.authService.logoutEverywhere(user.id, user.role);
    clearRefreshCookie(res, kind);
    return { message: "Successfully logged out" };
  }

  @UseGuards(JwtAuthGuard)
  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current user profile" })
  @ApiResponse({ status: 200, description: "Current user profile" })
  @SignedIn()
  async getProfile(@CurrentUser() user: any) {
    return user;
  }

  @UseGuards(JwtAuthGuard)
  @Get("tenant")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current tenant information" })
  @ApiResponse({ status: 200, description: "Current tenant information" })
  @SignedIn()
  async getTenant(@CurrentUser() user: any) {
    return this.authService.getTenant(user.tenantId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  @Patch("tenant")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Update current tenant settings (Owner or Admin)" })
  @ApiResponse({ status: 200, description: "Tenant updated successfully" })
  async updateTenant(
    @CurrentUser() user: any,
    @Body() updateTenantDto: UpdateTenantDto,
  ) {
    return this.authService.updateTenant(user.tenantId, updateTenantDto);
  }
}
