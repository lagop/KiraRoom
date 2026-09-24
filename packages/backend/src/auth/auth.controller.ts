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

@ApiTags("Authentication")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Get("verify-email")
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
  @ApiOperation({ summary: "Register a new tenant with owner account" })
  @ApiResponse({ status: 201, description: "Successfully registered" })
  @ApiResponse({ status: 409, description: "Email already registered" })
  @ApiResponse({ status: 400, description: "Invalid input" })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Login and get access/refresh tokens" })
  @ApiResponse({ status: 200, description: "Successfully logged in" })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Public()
  @Post("impersonate")
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
  async logout(@CurrentUser("id") userId: string) {
    await this.authService.logout(userId);
    return { message: "Successfully logged out" };
  }

  @UseGuards(JwtAuthGuard)
  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current user profile" })
  @ApiResponse({ status: 200, description: "Current user profile" })
  async getProfile(@CurrentUser() user: any) {
    return user;
  }

  @UseGuards(JwtAuthGuard)
  @Get("tenant")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current tenant information" })
  @ApiResponse({ status: 200, description: "Current tenant information" })
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
