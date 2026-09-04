import { ParseUUIDPipe, BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";
import { Public } from "../auth/decorators/public.decorator";
import { AccountingService } from "./accounting.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import {
  RetryQueueDto,
  SyncInvoiceDto,
  UpdateAccountingSettingsDto,
} from "./dto/accounting.dto";
import { AccountingProvider } from "@prisma/client";

interface AuthedRequest extends Request {
  user: { tenantId?: string };
}

@Controller("accounting")
export class AccountingController {
  private readonly oauthStateSecret: string;

  constructor(
    private readonly accounting: AccountingService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {
    const secret = config.get<string>("OAUTH_STATE_SECRET");
    if (secret && secret.length >= 16) {
      this.oauthStateSecret = secret;
    } else if (config.get<string>("NODE_ENV") === "production") {
      throw new Error(
        "OAUTH_STATE_SECRET must be set to a 16+ char random value in production",
      );
    } else {
      // Dev / test only — log a loud warning so it never silently ships.
      // eslint-disable-next-line no-console
      console.warn(
        "[accounting] OAUTH_STATE_SECRET is unset; using insecure dev fallback. DO NOT deploy this build to production.",
      );
      this.oauthStateSecret = "dev-oauth-secret-do-not-use-in-production";
    }
  }

  // ---- Tenant-scoped endpoints ----

  @Get("settings")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  async getSettings(@Req() req: AuthedRequest) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: this.requireTenantId(req) },
      select: { accountingSettings: true, accountingConnection: true },
    });
    return tenant;
  }

  @Patch("settings")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner)
  async updateSettings(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateAccountingSettingsDto,
  ) {
    const tenantId = this.requireTenantId(req);
    const current = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { accountingSettings: true },
    });
    const merged = {
      ...((current?.accountingSettings as Record<string, unknown>) ?? {}),
      ...(dto.provider !== undefined ? { provider: dto.provider } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.syncOnIssue !== undefined ? { syncOnIssue: dto.syncOnIssue } : {}),
    };
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: { accountingSettings: merged as any },
      select: { accountingSettings: true },
    });
  }

  @Get("connect/:provider")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner)
  connect(
    @Req() req: AuthedRequest,
    @Param("provider") provider: AccountingProvider,
  ) {
    return this.accounting.buildAuthUrl(
      provider,
      this.requireTenantId(req),
      this.oauthStateSecret,
    );
  }

  /**
   * OAuth callback. Public (no JWT) because the browser is coming from
   * Holded/Sage. The HMAC-signed `state` query param proves which tenant
   * initiated the flow.
   */
  @Public()
  @Get("callback/:provider")
  async callback(
    @Param("provider") provider: AccountingProvider,
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: Response,
  ) {
    if (!code || !state) {
      throw new BadRequestException("code and state query params required");
    }
    const [payloadB64, sig] = state.split(".");
    if (!payloadB64 || !sig) {
      throw new BadRequestException("malformed state");
    }
    const payload = Buffer.from(payloadB64, "base64url").toString();
    const expected = this.encryption.hmac(payload, this.oauthStateSecret);
    if (sig !== expected) {
      throw new BadRequestException("invalid state signature");
    }
    const [tenantId, callbackProvider] = payload.split("|");
    if (callbackProvider !== provider) {
      throw new BadRequestException("provider mismatch");
    }
    await this.accounting.completeOAuth(
      provider,
      tenantId,
      code,
      this.oauthStateSecret,
    );
    // Redirect the browser back to the dashboard.
    return res.redirect(
      302,
      `${this.config.get<string>("FRONTEND_BASE_URL") ?? "http://localhost:3000"}/dashboard/settings/accounting?connected=${provider}`,
    );
  }

  @Post("disconnect")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner)
  async disconnect(@Req() req: AuthedRequest) {
    await this.accounting.disconnect(this.requireTenantId(req));
    return { ok: true };
  }

  @Post("sync")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  async sync(@Body() dto: SyncInvoiceDto) {
    return this.accounting.syncInvoice(dto.invoiceId);
  }

  @Post("retry-queue")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner)
  async retryQueue(@Body() dto: RetryQueueDto) {
    return this.accounting.retryQueue(dto.limit ?? 50);
  }

  @Get("log")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  async log(
    @Req() req: AuthedRequest,
    @Query("limit") limit?: string,
  ) {
    const parsed = limit ? Math.min(parseInt(limit, 10) || 100, 200) : 100;
    return this.accounting.recentLogs(this.requireTenantId(req), parsed);
  }

  private requireTenantId(req: AuthedRequest): string {
    const t = req.user?.tenantId;
    if (!t) throw new Error("Missing tenantId on authenticated request");
    return t;
  }
}