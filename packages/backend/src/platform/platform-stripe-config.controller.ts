import { Body, Controller, Get, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlatformStripeConfigPublic, PlatformStripeConfigService } from "./platform-stripe-config.service";
import { UpdatePlatformStripeConfigDto } from "./platform-stripe-config.dto";

interface AuthedRequest {
  user: { id: string; role: string };
}

/**
 * KiraRoom's own Stripe account settings, for the saas_owner only. GET never
 * returns the secret key or the webhook secret; PUT takes them write-only.
 */
@ApiTags("platform-stripe-config")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("platform/stripe-config")
export class PlatformStripeConfigController {
  constructor(private readonly service: PlatformStripeConfigService) {}

  @Get()
  @Roles("saas_owner")
  get(): PlatformStripeConfigPublic {
    return this.service.getConfig();
  }

  @Put()
  @Roles("saas_owner")
  update(@Req() req: AuthedRequest, @Body() body: UpdatePlatformStripeConfigDto): Promise<PlatformStripeConfigPublic> {
    return this.service.update(
      {
        secretKey: body.secretKey,
        publishableKey: body.publishableKey,
        webhookSecret: body.webhookSecret,
        taxEnabled: body.taxEnabled,
      },
      { id: req.user.id, role: req.user.role },
    );
  }

  /** Reads the Stripe account the key belongs to (name, mode, can it charge). */
  @Post("test")
  @Roles("saas_owner")
  test(): Promise<{ ok: boolean; message: string }> {
    return this.service.testConnection();
  }
}
