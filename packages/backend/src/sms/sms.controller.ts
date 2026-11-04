import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { FeatureGuard } from "../common/guards/feature.guard";
import { SmsService } from "../notifications/services/sms.service";

@ApiTags("sms")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Controller("sms")
export class SmsController {
  constructor(private readonly sms: SmsService) {}

  /**
   * Lightweight status check — does NOT require an active plan feature
   * (you can read whether SMS is configured regardless of plan).
   */
  @Get("status")
  @Roles(...SALON_MANAGERS)
  status() {
    return { configured: this.sms.isConfigured() };
  }

  // POST /sms/test is gone (channels audit M8): it sent any text to any
  // number from the platform's Twilio account at the platform's cost.
}
