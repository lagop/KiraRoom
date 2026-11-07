import { Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SaasOwnerGuard } from "./guards/saas-owner.guard";
import { SaasOwner } from "./decorators/saas-owner.decorator";
import { parseMonthsParam } from "./platform-metrics";
import { SubscriptionBillingService } from "./subscription-billing.service";

@ApiTags("SaaS Management")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SaasOwnerGuard)
@SaasOwner()
@Controller("saas/billing")
export class SubscriptionBillingController {
  constructor(private readonly billing: SubscriptionBillingService) {}

  @Get("invoices")
  @ApiOperation({ summary: "KiraRoom's plan invoices to the salons (SaaS Owner only)" })
  list(
    @Query("tenantId") tenantId?: string,
    @Query("status") status?: string,
    @Query("month") month?: string,
    @Query("mode") mode?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.billing.list({ tenantId, status, month, mode, page: Number(page), limit: Number(limit) });
  }

  @Get("summary")
  @ApiOperation({ summary: "Takings, refunds and failed payments per month (SaaS Owner only)" })
  summary(@Query("mode") mode?: string, @Query("months") months?: string) {
    return this.billing.summary(mode, parseMonthsParam(months));
  }

  @Post("sync")
  @ApiOperation({ summary: "Fill the invoice copy from Stripe's latest invoices (SaaS Owner only)" })
  sync(@Req() req: { user: { id: string; role: string } }) {
    return this.billing.sync(req.user);
  }
}
