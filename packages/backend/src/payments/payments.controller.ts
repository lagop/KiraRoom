import {
  ParseUUIDPipe,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { PaymentsService } from "./payments.service";
import { SubscriptionsService } from "./services/subscriptions.service";
import { WalletService } from "./services/wallet.service";
import { StripeService } from "./services/stripe.service";
import { ProfessionalsService } from "../professionals/professionals.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS, SALON_TEAM } from "../auth/decorators/roles.decorator";
import {
  UpdateStripeSettingsDto,
  StripeSettingsResponseDto,
} from "./dto/stripe-settings.dto";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
import { Public } from "../auth/decorators/public.decorator";
import { AllowWhenReadOnly } from "../common/decorators/allow-when-read-only.decorator";
import { ReadOnlyNoticeService } from "./read-only-notice.service";
import {
  CancelSubscriptionDto,
  CreatePaymentBodyDto,
  RefundPaymentDto,
  SubscriptionPlanDto,
  UpdateLocationCountDto,
  WalletAmountDto,
} from "./dto/payment-bodies.dto";
import { PaymentFiltersDto, PaymentsListQueryDto } from "./payments-query";

/**
 * Who sees which payments:
 *
 * - owner / admin: every payment of the salon; only they refund, see the
 *   summary or move wallet money.
 * - staff: only the payments of their own appointments. A staff user with
 *   no professional record gets a 403: they used to get every payment of
 *   the salon (the professional filter was simply left out).
 *
 * Removed (no page used them, and each could rewrite the till's history):
 * PATCH /payments/:id/status (any status, any time, completing the
 * appointment past its consent checks), POST /payments/appointments/:id/
 * deposit and /collect-balance ('paid' payments with no check, twice if
 * called twice, on a cancelled visit too) and POST /payments/confirm/:id
 * (marked a payment paid without asking Stripe). Payments are taken at the
 * till (POS) and given back with POST /payments/:id/refund.
 */
@ApiTags("Payments")
@Controller("payments")
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@ApiBearerAuth()
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly walletService: WalletService,
    private readonly stripeService: StripeService,
    private readonly professionalsService: ProfessionalsService,
    private readonly readOnlyNotices: ReadOnlyNoticeService,
  ) {}

  /**
   * null for owner/admin (no filter), the professional's id for staff, and
   * a 403 for a staff user with no professional record (fail closed).
   */
  private async staffScope(req: any): Promise<string | null> {
    if (req.user.role !== "staff") return null;
    const professional = await this.professionalsService.getProfessionalByUserId(
      req.user.id,
      req.user.tenantId,
    );
    if (!professional?.id) {
      throw new ForbiddenException(
        "Tu usuario no tiene ficha de profesional: no puedes ver cobros. Pide al responsable del salón que te la asigne.",
      );
    }
    return professional.id;
  }

  // ============ PAYMENTS ============

  @Get()
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "The salon's payments (staff: their appointments')" })
  async getPayments(@Req() req: any, @Query() query: PaymentsListQueryDto) {
    const professionalId = await this.staffScope(req);
    return this.paymentsService.getPayments(req.user.tenantId, professionalId, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      status: query.status,
      method: query.method,
      clientId: query.clientId,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  }

  @Get("today")
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Today's payments (the salon's day) for the till" })
  async getTodayPayments(@Req() req: any) {
    const professionalId = await this.staffScope(req);
    return this.paymentsService.getTodayPayments(req.user.tenantId, professionalId);
  }

  @Get("stats/summary")
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "The Pagos page's cards, for the list's filters" })
  async getPaymentStats(@Req() req: any, @Query() query: PaymentFiltersDto) {
    return this.paymentsService.getSummary(req.user.tenantId, {
      method: query.method,
      clientId: query.clientId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  }

  @Get("appointment/:appointmentId")
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Get payments by appointment" })
  async getPaymentsByAppointment(
    @Req() req: any,
    @Param("appointmentId", ParseUUIDPipe) appointmentId: string,
  ) {
    const professionalId = await this.staffScope(req);
    return this.paymentsService.getPaymentsByAppointment(req.user.tenantId, appointmentId, professionalId);
  }

  @Get("client/:clientId")
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Get payments by client" })
  async getPaymentsByClient(
    @Req() req: any,
    @Param("clientId", ParseUUIDPipe) clientId: string,
  ) {
    const professionalId = await this.staffScope(req);
    // (tenantId, clientId): the two were swapped, so the history filtered on
    // the client's id as the salon and was always empty.
    return this.paymentsService.getPaymentsByClient(req.user.tenantId, clientId, professionalId);
  }

  @Get(":id")
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Get payment by ID" })
  async getPayment(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    const professionalId = await this.staffScope(req);
    return this.paymentsService.getPaymentById(req.user.tenantId, id, professionalId);
  }

  @Delete(":id")
  @Roles("owner")
  @ApiOperation({
    summary: "Delete a pending or failed payment (owner only, older than 24h)",
  })
  async deletePayment(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    // Validar que el pago tenga más de 24 horas
    const payment = await this.paymentsService.getPaymentById(
      req.user.tenantId,
      id,
    );
    const paymentAge = Date.now() - new Date(payment.createdAt).getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (paymentAge < twentyFourHours) {
      throw new BadRequestException(
        "Solo se pueden borrar cobros de hace más de 24 horas.",
      );
    }

    return this.paymentsService.deletePayment(req.user.tenantId, id);
  }

  @Post()
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Create a new (pending) payment" })
  async createPayment(
    @Req() req: any,
    @Body() body: CreatePaymentBodyDto,
  ) {
    const professionalId = await this.staffScope(req);

    return this.paymentsService.createPayment(
      req.user.tenantId,
      professionalId,
      {
        clientId: body.clientId || "",
        appointmentId: body.appointmentId,
        amount: body.amount,
        method: body.method || "cash",
        type: (body.type as any) || "appointment",
        status: "pending",
        description: body.description,
      },
    );
  }

  /**
   * Gives back all or part of a charge taken at the salon (owner/admin):
   * PaymentsService.refundPayment.
   */
  @Post(":id/refund")
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Refund all or part of a payment taken at the salon" })
  async refundPayment(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RefundPaymentDto,
  ) {
    return this.paymentsService.refundPayment(
      req.user.tenantId,
      id,
      { amount: body.amount, reason: body.reason },
      req.user.id,
    );
  }

  // ============ SUBSCRIPTIONS ============

  @Get("subscription/current")
  @Roles("owner")
  @ApiOperation({ summary: "Get current subscription" })
  async getSubscription(@Req() req: any) {
    return this.subscriptionsService.getSubscription(req.user.tenantId);
  }

  @Post("subscription/checkout")
  @AllowWhenReadOnly()
  @Roles("owner")
  @ApiOperation({ summary: "Create subscription checkout session" })
  async createCheckout(@Req() req: any, @Body() body: SubscriptionPlanDto) {
    return this.subscriptionsService.createCheckoutSession(
      req.user.tenantId,
      body.plan,
    );
  }

  @Post("subscription/change-plan")
  @AllowWhenReadOnly()
  @Roles("owner")
  @ApiOperation({ summary: "Change subscription plan" })
  async changePlan(@Req() req: any, @Body() body: SubscriptionPlanDto) {
    return this.subscriptionsService.changePlan(req.user.tenantId, body.plan);
  }

  @Post("subscription/cancel")
  @AllowWhenReadOnly()
  @Roles("owner")
  @ApiOperation({ summary: "Cancel subscription" })
  async cancelSubscription(
    @Req() req: any,
    @Body() body: CancelSubscriptionDto,
  ) {
    const { newlyCancelled, ...result } = await this.subscriptionsService.cancelSubscription(
      req.user.tenantId,
      body.immediately,
    );
    // Confirmation to the owner. Only here: a SaaS-console deletion also
    // cancels, and that salon is not told its account is read-only.
    if (newlyCancelled) {
      await this.readOnlyNotices.notify(req.user.tenantId, "cancelled", result.readOnlyUntil);
    }
    return result;
  }

  @Post("subscription/reactivate")
  @AllowWhenReadOnly()
  @Roles("owner")
  @ApiOperation({
    summary:
      "Reactivate a previously cancelled subscription (rev 3 read-only flow)",
  })
  async reactivateSubscription(@Req() req: any) {
    return this.subscriptionsService.reactivateSubscription(req.user.tenantId);
  }

  @Post("subscription/billing-portal")
  @AllowWhenReadOnly()
  @Roles("owner")
  @ApiOperation({ summary: "Open a Stripe Customer Portal session so the tenant owner can manage card, billing address and invoices" })
  async createBillingPortalSession(@Req() req: any) {
    const returnUrl = (process.env.FRONTEND_URL || "http://localhost:3000") + "/dashboard/billing";
    return this.subscriptionsService.createBillingPortalSession(req.user.tenantId, returnUrl);
  }
  @Post("subscription/update-locations")
  @AllowWhenReadOnly()
  @Roles("owner")
  @ApiOperation({
    summary: "Update the number of locations (only valid for plan=empresa)",
  })
  async updateLocationCount(
    @Req() req: any,
    @Body() body: UpdateLocationCountDto,
  ) {
    return this.subscriptionsService.updateLocationCount(
      req.user.tenantId,
      body.locationCount,
    );
  }

  @Get("subscription/trial-status")
  @Roles("owner", "admin")
  @ApiOperation({ summary: "Get trial status for the current tenant" })
  async getTrialStatus(@Req() req: any) {
    const sub = await this.subscriptionsService.getSubscription(
      req.user.tenantId,
    );
    const now = Date.now();
    const trialEnd = sub.trialEnd ? new Date(sub.trialEnd).getTime() : null;
    const daysRemaining = trialEnd
      ? Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)))
      : 0;
    return {
      inTrial: sub.status === "trialing" && trialEnd !== null && trialEnd > now,
      daysRemaining,
      trialEnd: sub.trialEnd ?? null,
      subscriptionStatus: sub.status,
    };
  }

  @Get("subscription/invoices")
  @Roles("owner")
  @ApiOperation({ summary: "Get subscription invoices" })
  async getInvoices(@Req() req: any, @Query("limit") limit?: string) {
    return this.subscriptionsService.getInvoices(
      req.user.tenantId,
      limit ? parseInt(limit) : 10,
    );
  }

  @Get("subscription/usage")
  @Roles("owner")
  @ApiOperation({ summary: "Get subscription usage stats" })
  async getUsageStats(@Req() req: any) {
    return this.subscriptionsService.getUsageStats(req.user.tenantId);
  }

  @Get("subscription/plans")
  // Public: the catalogue (names, prices, features) is what the landing page
  // shows before anyone signs up. It was owner-only, so the "Precios"
  // section asked for it without a session, got a 401 and showed nothing.
  @Public()
  @ApiOperation({ summary: "Get available subscription plans (rev 3, no parked features)" })
  async getPlans() {
    return this.subscriptionsService.getPublicPlans();
  }


  // ============ WALLET ============

  @Get("wallet/:clientId")
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Get client wallet" })
  async getWallet(@Req() req: any, @Param("clientId", ParseUUIDPipe) clientId: string) {
    await this.walletService.assertClientOfSalon(req.user.tenantId, clientId);
    return this.walletService.getWallet(req.user.tenantId, clientId);
  }

  /** The first deposit creates the client's wallet. */
  @Post("wallet/:clientId/deposit")
  @Roles(...SALON_MANAGERS)
  @Feature("wallet" as any)
  @ApiOperation({ summary: "Deposit funds to client wallet" })
  async depositWallet(
    @Req() req: any,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Body() body: WalletAmountDto,
  ) {
    await this.walletService.assertClientOfSalon(req.user.tenantId, clientId);
    return this.walletService.addFunds(
      req.user.tenantId,
      clientId,
      Math.round(body.amount),
      body.description,
    );
  }

  @Post("wallet/:clientId/withdraw")
  @Roles(...SALON_MANAGERS)
  @Feature("wallet" as any)
  @ApiOperation({ summary: "Withdraw funds from client wallet" })
  async withdrawWallet(
    @Req() req: any,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Body() body: WalletAmountDto,
  ) {
    await this.walletService.assertClientOfSalon(req.user.tenantId, clientId);
    return this.walletService.deductFunds(
      req.user.tenantId,
      clientId,
      Math.round(body.amount),
      body.description || "Retirada",
    );
  }

  @Get("wallet/:clientId/transactions")
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Get client wallet transactions" })
  async getWalletTransactions(
    @Req() req: any,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Query("limit") limit?: string,
  ) {
    await this.walletService.assertClientOfSalon(req.user.tenantId, clientId);
    const n = Number.parseInt(limit ?? "", 10);
    return this.walletService.getClientTransactions(
      req.user.tenantId,
      clientId,
      Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20,
    );
  }

  @Get("wallet/:clientId/stats")
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Get client wallet stats" })
  async getWalletStats(@Req() req: any, @Param("clientId", ParseUUIDPipe) clientId: string) {
    await this.walletService.assertClientOfSalon(req.user.tenantId, clientId);
    return this.walletService.getWalletStats(req.user.tenantId, clientId);
  }

  // POST wallet/:clientId/points/earn and /redeem used to be here. They
  // moved ClientWallet.loyaltyPoints, which nothing has read since loyalty
  // moved to the LoyaltyTransaction ledger (#120): points "added" here never
  // reached the client's real balance, and the Pagos page kept showing 0.
  // Points are adjusted in Fidelización (/loyalty/members/:id/adjust).

  // ============ STRIPE SETTINGS ============

  /**
   * The salon's own Stripe keys. The secret keys are never sent back whole:
   * masked, plus whether one is saved (StripeService.getTenantSettings). It
   * used to open a new database connection per request and never close it.
   */
  @Get("stripe/settings")
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Get Stripe configuration for tenant (secret keys masked)" })
  async getStripeSettings(@Req() req: any): Promise<StripeSettingsResponseDto> {
    return this.stripeService.getTenantSettings(req.user.tenantId);
  }

  @Patch("stripe/settings")
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Update Stripe configuration for tenant" })
  async updateStripeSettings(
    @Req() req: any,
    @Body() dto: UpdateStripeSettingsDto,
  ) {
    return this.stripeService.updateTenantSettings(req.user.tenantId, dto);
  }

  @Get("stripe/publishable-key")
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Get Stripe publishable key for frontend" })
  async getStripePublishableKey(@Req() req: any) {
    const tenantId = req.user.tenantId;
    const publishableKey =
      await this.stripeService.getPublishableKeyForTenant(tenantId);
    return { publishableKey };
  }
}
