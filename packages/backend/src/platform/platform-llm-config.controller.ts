import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import {
  PlatformLlmConfigService,
  PlatformLlmConfigPublic,
} from "./platform-llm-config.service";

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
    @Body() body: {
      provider?: string;
      apiKey?: string;
      defaultModel?: string;
      baseUrl?: string | null;
      workspaceId?: string | null;
    },
  ): Promise<PlatformLlmConfigPublic> {
    return this.service.updateConfig({
      provider: body.provider,
      apiKey: body.apiKey,
      defaultModel: body.defaultModel,
      baseUrl: body.baseUrl,
      workspaceId: body.workspaceId,
      updatedBy: req.user?.id,
    });
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
    @Body() body: { apiKey: string },
  ): Promise<{
    ok: boolean;
    workspaces: Array<{ id: string; name?: string; type?: string; default?: boolean }>;
    message?: string;
  }> {
    return this.service.listAnthropicWorkspaces(body?.apiKey ?? "");
  }
}