import { Body, Controller, Get, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import {
  PlatformLlmConfigService,
  PlatformLlmConfigPublic } from "./platform-llm-config.service";
import { AnthropicWorkspacesDto, UpdatePlatformLlmConfigDto } from "./platform-llm-config.dto";
import { UserRole } from "@prisma/client";
import { AuditLogService } from "../saas/audit-log.service";

interface AuthedRequest {
  user: { id: string; tenantId: string; role: string };
}

/**
 * P2A-platform-llm: admin-only endpoints to manage the platform-wide
 * LLM provider config. Restricted to the `saas_owner` role — salon
 * owners and tenant admins do not have access.
 *
 * The GET endpoint never returns the plaintext API key. The PUT
 * endpoint accepts a new plaintext key (encrypted before persisting).
 */
@ApiTags("platform-llm-config")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("platform/llm-config")
export class PlatformLlmConfigController {
  constructor(
    private readonly service: PlatformLlmConfigService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  @Roles("saas_owner")
  async get(): Promise<PlatformLlmConfigPublic> {
    return this.service.getConfig();
  }

  @Put()
  @Roles("saas_owner")
  async update(
    @Req() req: AuthedRequest,
    @Body() body: UpdatePlatformLlmConfigDto,
  ): Promise<PlatformLlmConfigPublic> {
    const out = await this.service.updateConfig({
      provider: body.provider,
      apiKey: body.apiKey,
      defaultModel: body.defaultModel,
      baseUrl: body.baseUrl,
      workspaceId: body.workspaceId,
      updatedBy: req.user?.id });
    // Audit 8, C9: as the Stripe and email settings are. Which settings
    // were sent, and the non-secret ones' values; never the key.
    await this.auditLog.record("platform.llm_config.updated", {
      actorId: req.user.id,
      actorRole: UserRole.saas_owner,
      metadata: {
        set: Object.entries(body ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k]) => k),
        provider: body.provider ?? null,
        defaultModel: body.defaultModel ?? null,
        apiKeyChanged: typeof body.apiKey === "string" && body.apiKey.length > 0,
      },
    });
    return out;
  }

  @Post("test")
  @Roles("saas_owner")
  async test(): Promise<{
    ok: boolean;
    message: string;
    model?: string;
    latencyMs?: number;
  }> {
    return this.service.testConnection();
  }

  /**
   * P2A-anthropic-workspace: list the workspaces a given Anthropic
   * API key has access to. The API key is sent in the request body
   * and is NEVER persisted — this is purely a discovery endpoint to
   * help admins find their workspace ID.
   */
  @Post("anthropic/workspaces")
  @Roles("saas_owner")
  async listAnthropicWorkspaces(
    @Body() body: AnthropicWorkspacesDto,
  ): Promise<{
    ok: boolean;
    workspaces: Array<{ id: string; name?: string; type?: string; default?: boolean }>;
    message?: string;
  }> {
    return this.service.listAnthropicWorkspaces(body?.apiKey ?? "");
  }
}