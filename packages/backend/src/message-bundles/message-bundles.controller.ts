import { Body, Controller, Get, Param, Post, UseGuards, ForbiddenException } from "@nestjs/common";
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { MessageBundlesService } from './message-bundles.service';
import { SaasOwner } from "../saas/decorators/saas-owner.decorator";
import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";

/** Credits are whole messages. Was an inline type checked by hand. */
export class TopUpCreditsDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  credits!: number;
}

@Controller('message-bundles')
@UseGuards(JwtAuthGuard)
export class MessageBundlesController {
  constructor(private readonly svc: MessageBundlesService) {}

  private requireSaas(user: { role?: string }) {
    if (user.role !== 'saas_owner') {
      throw new ForbiddenException('SaaS-admin access required');
    }
  }

  /**
   * Read the current credit balance for a tenant. Marketing pipelines
   * call this before dispatching a campaign to know whether to skip.
   */
  @Get('tenants/:tenantId/balance')
  @SaasOwner()
  balance(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
  ) {
    this.requireSaas(user);
    return this.svc.getBalance(tenantId);
  }

  /**
   * SaaS-admin manual top-up. Used when:
   *   - the customer paid out-of-band (cash, bank transfer, etc.)
   *   - we want to gift credits (referrals, support escalations)
   *
   * Stripe-driven top-ups go through `invoice.payment_succeeded`
   * webhook -> `creditTopUp({ source: 'stripe' })`.
   */
  @Post('tenants/:tenantId/topup')
  @SaasOwner()
  topUp(
    @Param('tenantId') tenantId: string,
    @Body() body: TopUpCreditsDto,
    @CurrentUser() user: any,
  ) {
    this.requireSaas(user);
    if (typeof body.credits !== 'number' || body.credits <= 0) {
      throw new ForbiddenException('credits must be a positive number');
    }
    return this.svc.creditTopUp({
      tenantId,
      credits: body.credits,
      source: 'manual' });
  }
}
