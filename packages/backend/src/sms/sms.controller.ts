import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
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
  status() {
    return { configured: this.sms.isConfigured() };
  }

  /**
   * Sends a single test SMS — gated by `sms_notifications` (Pro+).
   */
  @Post("test")
  @Roles("owner", "admin")
  @Feature("sms_notifications")
  async test(
    @Req() req: any,
    @Body() dto: { to: string; body: string },
  ) {
    const result = await this.sms.sendSms({
      to: dto.to,
      body: dto.body });
    return {
      success: result.success,
      id: result.id,
      error: result.error,
      tenantId: req.user.tenantId };
  }
}
