import { Body, Controller, Get, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import {
  PlatformStripeConfigPublic,
  PlatformStripeConfigService,
  PlatformStripeConfigUpdate,
  StripeChangePreview,
  StripeTestModePlans,
} from "./platform-stripe-config.service";
import { TestPlatformStripeDto, UpdatePlatformStripeConfigDto } from "./platform-stripe-config.dto";

interface AuthedRequest {
  user: { id: string; role: string };
}

function updateOf(body: UpdatePlatformStripeConfigDto): PlatformStripeConfigUpdate {
  return {
    secretKey: body.secretKey,
    publishableKey: body.publishableKey,
    webhookSecret: body.webhookSecret,
    otherWebhookSecret: body.otherWebhookSecret,
    otherSecretKey: body.otherSecretKey,
    otherPublishableKey: body.otherPublishableKey,
    switchMode: body.switchMode,
  };
}

/**
 * KiraRoom's own Stripe account settings, for the saas_owner only. GET never
 * returns the secret key or the webhook secrets; PUT takes them write-only.
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

  /** Real salons with a plan activated by a test-mode payment (nothing charged), to review. */
  @Get("test-mode-plans")
  @Roles("saas_owner")
  testModePlans(): Promise<StripeTestModePlans> {
    return this.service.testModePlans();
  }

  @Put()
  @Roles("saas_owner")
  update(@Req() req: AuthedRequest, @Body() body: UpdatePlatformStripeConfigDto): Promise<PlatformStripeConfigPublic> {
    return this.service.update(updateOf(body), { id: req.user.id, role: req.user.role });
  }

  /**
   * What PUT with this body would do, without saving: the resulting mode,
   * why it would be refused, and on a mode change the salons with the
   * other mode's customer or subscription.
   */
  @Post("preview")
  @Roles("saas_owner")
  preview(@Body() body: UpdatePlatformStripeConfigDto): Promise<StripeChangePreview> {
    return this.service.preview(updateOf(body));
  }

  /** Reads the Stripe account a key belongs to (name, mode, can it charge): the typed one, else the one in force. */
  @Post("test")
  @Roles("saas_owner")
  test(@Body() body: TestPlatformStripeDto): Promise<{ ok: boolean; message: string }> {
    return this.service.testConnection(body?.secretKey);
  }
}
