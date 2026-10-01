import { Throttle } from "@nestjs/throttler";
import { PasswordResetService } from "./password-reset.service";
import { ForgotPasswordDto, ResetPasswordDto } from "./dto/password-reset.dto";
import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus, Get, Patch, Query } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth } from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { Public } from "./decorators/public.decorator";
import { Roles } from "./decorators/roles.decorator";
import { CurrentUser } from "./decorators/current-user.decorator";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "./guards/roles.guard";
import { UserRole } from "@prisma/client";
import { IMPERSONATION_AUDIENCE, IMPERSONATION_DEFAULT_REASON } from "../saas/saas.constants";
import { SignedIn } from "./decorators/signed-in.decorator";

@ApiTags("Authentication")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  /**
   * Emails a reset link if an account uses this address. Always the same
   * answer, so the endpoint does not tell who has an account.
   */
  @Public()
  @Post("forgot-password")
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per address
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Email a password reset link" })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
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

  @Public()
  @Post("register")
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } }) // 5 sign-ups an hour per address
  @ApiOperation({ summary: "Register a new tenant with owner account" })
  @ApiResponse({ status: 201, description: "Successfully registered" })
  @ApiResponse({ status: 409, description: "Email already registered" })
  @ApiResponse({ status: 400, description: "Invalid input" })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @Post("login")
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // with the per-account lockout
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Login and get access/refresh tokens" })
  @ApiResponse({ status: 200, description: "Successfully logged in" })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
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
  async impersonate(@Body() body: { token: string; reason?: string }) {
    return this.authService.impersonate(
      body.token,
      body.reason ?? IMPERSONATION_DEFAULT_REASON,
      IMPERSONATION_AUDIENCE,
    );
  }

  @Public()
  @Post("refresh")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Refresh access token using refresh token" })
  @ApiResponse({ status: 200, description: "Successfully refreshed token" })
  @ApiResponse({ status: 401, description: "Invalid refresh token" })
  async refreshToken(@Body("refreshToken") refreshToken: string) {
    return this.authService.refreshToken(refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Logout and invalidate tokens" })
  @ApiResponse({ status: 200, description: "Successfully logged out" })
  @SignedIn()
  async logout(@CurrentUser() user: { id: string; role: string }) {
    await this.authService.logout(user.id, user.role);
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
