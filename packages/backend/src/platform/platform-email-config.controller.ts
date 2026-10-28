import { Body, Controller, Get, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlatformEmailConfigPublic, PlatformEmailConfigService } from "./platform-email-config.service";
import { UpdatePlatformEmailConfigDto } from "./platform-email-config.dto";

interface AuthedRequest {
  user: { id: string; role: string };
}

/**
 * The platform's email settings (Resend), for the saas_owner only. GET never
 * returns the key or the webhook secret; PUT takes them write-only.
 */
@ApiTags("platform-email-config")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("platform/email-config")
export class PlatformEmailConfigController {
  constructor(private readonly service: PlatformEmailConfigService) {}

  @Get()
  @Roles("saas_owner")
  get(): PlatformEmailConfigPublic {
    return this.service.getConfig();
  }

  @Put()
  @Roles("saas_owner")
  update(@Req() req: AuthedRequest, @Body() body: UpdatePlatformEmailConfigDto): Promise<PlatformEmailConfigPublic> {
    return this.service.update(
      { apiKey: body.apiKey, from: body.from, webhookSecret: body.webhookSecret },
      { id: req.user.id, role: req.user.role },
    );
  }

  /** Sends a test email to the signed-in admin with the settings in force. */
  @Post("test")
  @Roles("saas_owner")
  test(@Req() req: AuthedRequest): Promise<{ ok: boolean; message: string }> {
    return this.service.sendTest({ id: req.user.id, role: req.user.role });
  }
}
